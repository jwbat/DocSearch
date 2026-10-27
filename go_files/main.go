package main
// Command docsearch-cli syncs a local directory tree to S3 (content) and
// DynamoDB (manifest). It is the only write path in the Doc Search system —
// the web frontend is read-only and never touches AWS credentials directly.

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"docsearch-cli/internal/localfs"
	"docsearch-cli/internal/manifest"
	"docsearch-cli/internal/syncer"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	root := fs.String("root", envOr("DOCSEARCH_ROOT", "./Docs"), "local root directory to sync")
	if err := fs.Parse(os.Args[2:]); err != nil {
		os.Exit(1)
	}

	bucket := os.Getenv("DOCSEARCH_BUCKET")
	table := os.Getenv("DOCSEARCH_TABLE")
	if bucket == "" || table == "" {
		log.Fatal("DOCSEARCH_BUCKET and DOCSEARCH_TABLE environment variables must be set")
	}

	switch cmd {
	case "status", "sync":
		// handled below
	default:
		usage()
		os.Exit(1)
	}

	ctx := context.Background()
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatalf("loading AWS config: %v", err)
	}

	s3Client := s3.NewFromConfig(cfg)
	ddbClient := dynamodb.NewFromConfig(cfg)

	local, err := localfs.Walk(*root)
	if err != nil {
		log.Fatalf("walking local docs at %q: %v", *root, err)
	}

	remote, err := manifest.Fetch(ctx, ddbClient, table)
	if err != nil {
		log.Fatalf("fetching manifest from %q: %v", table, err)
	}

	plan := syncer.BuildPlan(local, remote)
	printPlan(plan)

	if cmd == "status" {
		return
	}

	// cmd == "sync"
	if plan.Empty() {
		return
	}
	if err := syncer.Execute(ctx, plan, local, s3Client, ddbClient, bucket, table); err != nil {
		log.Fatalf("sync failed: %v", err)
	}
	fmt.Println("Sync complete.")
}

func printPlan(p syncer.Plan) {
	for _, op := range p.Copy {
		fmt.Printf("Copy    %s -> %s\n", op.From, op.To)
	}
	for _, path := range p.Upload {
		fmt.Printf("Update  %s\n", path)
	}
	for _, path := range p.Delete {
		fmt.Printf("Delete  %s\n", path)
	}
	if p.Empty() {
		fmt.Println("Up to date.")
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func usage() {
	fmt.Fprintln(os.Stderr, `docsearch-cli: sync a local directory tree to S3 + DynamoDB

Usage:
  docsearch-cli status [-root path]   show pending changes without applying them
  docsearch-cli sync   [-root path]   apply pending changes

-root defaults to $DOCSEARCH_ROOT, or "./Docs" if unset.

Required environment variables:
  DOCSEARCH_BUCKET   S3 bucket name
  DOCSEARCH_TABLE    DynamoDB table name

AWS credentials and region are picked up via the standard AWS SDK chain
(environment variables, shared config/profile, or instance/role credentials).`)
}
