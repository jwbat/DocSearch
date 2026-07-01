# docsearch-cli

The CLI write path for the Doc Search system. Walks a local directory tree,
diffs it against the DynamoDB manifest by content hash, and pushes
changes (and only changes) directly to S3 + DynamoDB via the AWS SDK.

This talks to AWS directly with your own credentials — there's no Lambda
or API Gateway in this path. Those only exist for the read-only web
frontend later.

## Setup

```
go mod tidy   # pulls in the AWS SDK v2 modules listed in go.mod
go build -o docsearch-cli .
```

Requires Go 1.23+ (the AWS SDK's newest releases need 1.24; the versions
pinned in go.mod were chosen to work with 1.22/1.23 too — if you're on a
newer Go and want the latest SDK releases, `go get -u ./...` then
`go mod tidy` after confirming your toolchain version).

## Configuration

Set before running:

```
export DOCSEARCH_BUCKET=your-bucket-name
export DOCSEARCH_TABLE=your-table-name
```

AWS credentials and region come from the standard SDK chain — environment
variables, a shared `~/.aws/config` profile, or an assumed role. Nothing
AWS-specific needs to be passed on the command line.

## Usage

```
docsearch-cli status              # show what would change, make no changes
docsearch-cli status -root ~/Docs # point at a specific local root
docsearch-cli sync                # apply the changes
docsearch-cli sync -root ~/Docs
```

`-root` defaults to `$DOCSEARCH_ROOT`, or `./Docs` if that's unset too.

## How the diff works

- Every local file is hashed (SHA-256). Hash mismatch (or the path being
  unknown, or previously soft-deleted) means it gets uploaded.
- Any path known in DynamoDB (and not already soft-deleted) that's no
  longer present locally gets deleted: the S3 object is removed (with
  versioning on the bucket, this is just a delete marker — recoverable)
  and the DynamoDB item is flagged `deleted = true` rather than removed,
  so the manifest keeps its history.
- Filesystem mtime is intentionally not used for the diff — only content
  hash matters. This keeps the same diff logic reusable for a future
  client (e.g. browser-based) that can't rely on OS-level file metadata.

## Tests

```
go test ./...
```

`internal/syncer` has a test covering the diff logic (new file, unchanged
file, file removed locally, and a soft-deleted file reappearing locally)
that runs with no AWS dependency.
