// Command api-lambda is the Lambda behind the read-only HTTP API. It serves
// GET /manifest and GET /file-url; the routing and handlers live in
// internal/api. CDK builds this as the `bootstrap` binary for the
// provided.al2023 runtime — it isn't installed locally like the CLI.
package main

import (
	"context"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"docsearch-cli/internal/api"
)

func main() {
	table := os.Getenv("DOCSEARCH_TABLE")
	bucket := os.Getenv("DOCSEARCH_BUCKET")
	if table == "" || bucket == "" {
		log.Fatal("DOCSEARCH_TABLE and DOCSEARCH_BUCKET environment variables must be set")
	}

	// Clients are built once per cold start and reused across invocations.
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("loading AWS config: %v", err)
	}

	srv := &api.Server{
		DB:        dynamodb.NewFromConfig(cfg),
		Presigner: s3.NewPresignClient(s3.NewFromConfig(cfg)),
		Table:     table,
		Bucket:    bucket,
	}

	lambda.Start(srv.Handle)
}
