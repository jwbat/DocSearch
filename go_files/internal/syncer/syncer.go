// Package syncer diffs the local file tree against the remote manifest
// and applies the resulting changes to S3 and DynamoDB.
package syncer

import (
	"context"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"sort"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"docsearch-cli/internal/localfs"
	"docsearch-cli/internal/manifest"
)

// Plan is the set of changes needed to bring S3 + DynamoDB in line with
// the local directory tree.
type Plan struct {
	Upload []string
	Delete []string
}

// BuildPlan diffs local files against the known remote manifest.
//
// A path is queued for upload if it's new, its content hash differs from
// what's recorded remotely, or it was previously soft-deleted (the local
// file existing again means it should come back).
//
// A path is queued for deletion if it's known remotely (and not already
// soft-deleted) but no longer exists locally.
func BuildPlan(local map[string]localfs.LocalFile, remote map[string]manifest.Entry) Plan {
	var plan Plan

	for path, lf := range local {
		re, known := remote[path]
		if !known || re.Deleted || re.SHA256 != lf.SHA256 {
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

	sort.Strings(plan.Upload)
	sort.Strings(plan.Delete)
	return plan
}

// Execute applies the plan. Uploads go to S3 first, then get a full item
// written (or overwritten) in DynamoDB. Deletes remove the S3 object —
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
