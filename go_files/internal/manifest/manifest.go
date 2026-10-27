// Package manifest defines the shape of items in the DynamoDB manifest
// table and knows how to fetch the full table contents.
package manifest

import (
	"context"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// Entry mirrors one item in the DynamoDB manifest table.
type Entry struct {
	Path         string `dynamodbav:"path"`
	SHA256       string `dynamodbav:"sha256"`
	SizeBytes    int64  `dynamodbav:"size_bytes"`
	ModifiedTime string `dynamodbav:"modified_time"`
	ContentType  string `dynamodbav:"content_type"`
	Deleted      bool   `dynamodbav:"deleted"`
	DeletedAt    string `dynamodbav:"deleted_at,omitempty"`
}

// GetItemAPI is the slice of the DynamoDB client that Get needs, so
// callers can pass a fake in tests.
type GetItemAPI interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
}

// Fetch scans the whole table and returns every entry, keyed by path —
// including entries marked deleted. The CLI needs the full picture
// (unlike the read API, which filters deleted entries out) to tell
// whether a local file is new, changed, or a recreation of something
// that was previously deleted.
func Fetch(ctx context.Context, client dynamodb.ScanAPIClient, table string) (map[string]Entry, error) {
	result := make(map[string]Entry)

	paginator := dynamodb.NewScanPaginator(client, &dynamodb.ScanInput{
		TableName: &table,
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		var entries []Entry
		if err := attributevalue.UnmarshalListOfMaps(page.Items, &entries); err != nil {
			return nil, err
		}
		for _, e := range entries {
			result[e.Path] = e
		}
	}
	return result, nil
}

// Get looks up a single entry by path. The bool is false if no item
// exists; soft-deleted items are returned as-is for the caller to judge.
func Get(ctx context.Context, client GetItemAPI, table, path string) (Entry, bool, error) {
	key, err := attributevalue.MarshalMap(struct {
		Path string `dynamodbav:"path"`
	}{Path: path})
	if err != nil {
		return Entry{}, false, err
	}

	out, err := client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: &table,
		Key:       key,
	})
	if err != nil {
		return Entry{}, false, err
	}
	if out.Item == nil {
		return Entry{}, false, nil
	}

	var e Entry
	if err := attributevalue.UnmarshalMap(out.Item, &e); err != nil {
		return Entry{}, false, err
	}
	return e, true, nil
}

// Now returns the current time formatted the way manifest entries store it.
func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}
