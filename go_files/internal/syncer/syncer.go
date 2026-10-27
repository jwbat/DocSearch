// Package syncer diffs the local file tree against the remote manifest
// and applies the resulting changes to S3 and DynamoDB.
package syncer

import (
	"context"
	"fmt"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"

	"docsearch-cli/internal/localfs"
	"docsearch-cli/internal/manifest"
)

// Plan is the set of changes needed to bring S3 + DynamoDB in line with
// the local directory tree.
type Plan struct {
	Copy   []CopyOp
	Upload []string
	Delete []string
}

// CopyOp is a local file whose content already exists in S3 under another
// key, so it can be copied server-side instead of uploaded. This is what
// makes a directory rename cheap: each new path copies from its old one.
type CopyOp struct {
	From string
	To   string
}

// Empty reports whether the plan has nothing to do.
func (p Plan) Empty() bool {
	return len(p.Copy) == 0 && len(p.Upload) == 0 && len(p.Delete) == 0
}

// maxCopyBytes is the largest object a single S3 CopyObject call accepts.
// Anything bigger falls back to a normal upload.
const maxCopyBytes = 5 << 30

// BuildPlan diffs local files against the known remote manifest.
//
// A path is queued for upload if it's new, its content hash differs from
// what's recorded remotely, or it was previously soft-deleted (the local
// file existing again means it should come back).
//
// A path that would be uploaded is turned into a server-side copy instead
// when a live remote entry already holds the same content. The source must
// not itself be queued for upload, since that would overwrite it.
//
// A path is queued for deletion if it's known remotely (and not already
// soft-deleted) but no longer exists locally.
func BuildPlan(local map[string]localfs.LocalFile, remote map[string]manifest.Entry) Plan {
	var plan Plan

	var pending []string
	uploading := make(map[string]bool)
	for path, lf := range local {
		re, known := remote[path]
		if !known || re.Deleted || re.SHA256 != lf.SHA256 {
			pending = append(pending, path)
			uploading[path] = true
		}
	}

	sources := copySources(remote, uploading)
	for _, path := range pending {
		lf := local[path]
		if from, ok := sources[lf.SHA256]; ok && lf.SizeBytes <= maxCopyBytes {
			plan.Copy = append(plan.Copy, CopyOp{From: from, To: path})
		} else {
			plan.Upload = append(plan.Upload, path)
		}
	}

	for path, re := range remote {
		if re.Deleted {
			continue
		}
		if _, stillLocal := local[path]; !stillLocal {
			plan.Delete = append(plan.Delete, path)
		}
	}

	sort.Slice(plan.Copy, func(i, j int) bool { return plan.Copy[i].To < plan.Copy[j].To })
	sort.Strings(plan.Upload)
	sort.Strings(plan.Delete)
	return plan
}

// copySources maps each content hash to a live remote path holding that
// content, skipping paths about to be overwritten. When several paths share
// a hash, the lexically smallest wins so plans are deterministic.
func copySources(remote map[string]manifest.Entry, uploading map[string]bool) map[string]string {
	sources := make(map[string]string)
	for path, re := range remote {
		if re.Deleted || uploading[path] {
			continue
		}
		if cur, ok := sources[re.SHA256]; !ok || path < cur {
			sources[re.SHA256] = path
		}
	}
	return sources
}

// Execute applies the plan. Copies and uploads go to S3 first, then get a
// full item written (or overwritten) in DynamoDB. Copies run before deletes
// because a copy's source is often one of the paths being deleted (a
// rename). Deletes remove the S3 object —
// versioning means this just adds a delete marker, content is recoverable —
// then flip the DynamoDB item's deleted flag without touching its other
// attributes, so a future "restore" command has something to work with.
func Execute(
	ctx context.Context,
	plan Plan,
	local map[string]localfs.LocalFile,
	s3Client *s3.Client,
	ddbClient *dynamodb.Client,
	bucket, table string,
) error {
	for _, op := range plan.Copy {
		lf := local[op.To]
		if err := copyOne(ctx, op.From, lf, s3Client, ddbClient, bucket, table); err != nil {
			return fmt.Errorf("copying %s -> %s: %w", op.From, op.To, err)
		}
	}

	for _, path := range plan.Upload {
		lf := local[path]
		if err := uploadOne(ctx, lf, s3Client, ddbClient, bucket, table); err != nil {
			return fmt.Errorf("uploading %s: %w", path, err)
		}
	}

	for _, path := range plan.Delete {
		if err := deleteOne(ctx, path, s3Client, ddbClient, bucket, table); err != nil {
			return fmt.Errorf("deleting %s: %w", path, err)
		}
	}

	return nil
}

func uploadOne(
	ctx context.Context,
	lf localfs.LocalFile,
	s3Client *s3.Client,
	ddbClient *dynamodb.Client,
	bucket, table string,
) error {
	f, err := os.Open(lf.AbsPath)
	if err != nil {
		return err
	}
	defer f.Close()

	contentType := guessContentType(lf.Path)

	_, err = s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      &bucket,
		Key:         &lf.Path,
		Body:        f,
		ContentType: &contentType,
	})
	if err != nil {
		return fmt.Errorf("s3 put: %w", err)
	}

	return putEntry(ctx, lf, contentType, ddbClient, table)
}

// copyOne copies an existing S3 object to lf's path without re-sending the
// bytes. Metadata is replaced rather than copied so the Content-Type follows
// the new path's extension.
func copyOne(
	ctx context.Context,
	from string,
	lf localfs.LocalFile,
	s3Client *s3.Client,
	ddbClient *dynamodb.Client,
	bucket, table string,
) error {
	contentType := guessContentType(lf.Path)
	source := bucket + "/" + escapeKey(from)

	_, err := s3Client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:            &bucket,
		Key:               &lf.Path,
		CopySource:        &source,
		ContentType:       &contentType,
		MetadataDirective: s3types.MetadataDirectiveReplace,
	})
	if err != nil {
		return fmt.Errorf("s3 copy: %w", err)
	}

	return putEntry(ctx, lf, contentType, ddbClient, table)
}

// escapeKey URL-encodes an S3 key for use in CopySource, keeping the
// slashes between path segments intact.
func escapeKey(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// putEntry writes (or overwrites) lf's full item in the manifest table.
func putEntry(
	ctx context.Context,
	lf localfs.LocalFile,
	contentType string,
	ddbClient *dynamodb.Client,
	table string,
) error {
	entry := manifest.Entry{
		Path:         lf.Path,
		SHA256:       lf.SHA256,
		SizeBytes:    lf.SizeBytes,
		ModifiedTime: manifest.Now(),
		ContentType:  contentType,
		Deleted:      false,
	}
	item, err := attributevalue.MarshalMap(entry)
	if err != nil {
		return err
	}
	_, err = ddbClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &table,
		Item:      item,
	})
	if err != nil {
		return fmt.Errorf("dynamodb put: %w", err)
	}
	return nil
}

func deleteOne(
	ctx context.Context,
	path string,
	s3Client *s3.Client,
	ddbClient *dynamodb.Client,
	bucket, table string,
) error {
	_, err := s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: &bucket,
		Key:    &path,
	})
	if err != nil {
		return fmt.Errorf("s3 delete: %w", err)
	}

	key, err := attributevalue.MarshalMap(struct {
		Path string `dynamodbav:"path"`
	}{Path: path})
	if err != nil {
		return err
	}

	deletedVal, err := attributevalue.Marshal(true)
	if err != nil {
		return err
	}
	deletedAtVal, err := attributevalue.Marshal(manifest.Now())
	if err != nil {
		return err
	}

	expr := "SET deleted = :deleted, deleted_at = :deleted_at"
	_, err = ddbClient.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        &table,
		Key:              key,
		UpdateExpression: &expr,
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":deleted":    deletedVal,
			":deleted_at": deletedAtVal,
		},
	})
	if err != nil {
		return fmt.Errorf("dynamodb update: %w", err)
	}
	return nil
}

// guessContentType picks a Content-Type for the S3 object. Go's mime
// package doesn't know about Markdown out of the box, so a few common
// extensions are special-cased before falling back to its lookup table.
func guessContentType(path string) string {
	switch filepath.Ext(path) {
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".txt":
		return "text/plain; charset=utf-8"
	}
	if ct := mime.TypeByExtension(filepath.Ext(path)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}
