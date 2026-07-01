# DocSearch

A personal document storage and retrieval system built on AWS. Documents live
in a local directory tree, are synced to S3 by a CLI tool, and are browsable
via a read-only web frontend.

---

## Architecture Overview

```
Local Docs/          CLI (Go)           AWS
─────────────        ────────           ───────────────────────────
coding_notes/    →   hash & diff   →    S3 bucket (content)
  Go/                                   DynamoDB table (manifest)
  Python/
recipes/
music/
...
```

There are two distinct paths through the system — a **write path** used only
by the CLI, and a **read path** used only by the web frontend. They share the
same S3 bucket and DynamoDB table but are otherwise independent.

---

## Write Path (CLI only)

The CLI is the sole writer. It runs locally with your own AWS credentials and
talks to S3 and DynamoDB directly via the AWS SDK — no Lambda or API Gateway
is involved in this path.

**Sync flow:**

1. The CLI walks the local `Docs/` tree and computes a SHA-256 hash of every file.
2. It fetches the full manifest from DynamoDB (one scan).
3. It diffs local hashes against the manifest — only changed or new files are queued for upload; unchanged files are skipped entirely.
4. For each file that changed: `PutObject` to S3, then `PutItem` to DynamoDB to update the manifest entry (path, hash, size, content type, timestamp).
5. For each file deleted locally: `DeleteObject` on S3 (versioning means this adds a delete marker — content is recoverable), then a soft-delete flag (`deleted = true`, `deleted_at`) is written to the DynamoDB item. The item itself is never removed, so history is preserved.

Content hash — not filesystem modification time — is the sole basis for the
diff. This keeps the sync logic portable and correct across any client,
including a future browser-based one.

---

## Read Path (web frontend)

The web frontend is read-only and holds no AWS credentials. It reaches the
document store through two API Gateway endpoints backed by Go Lambda functions.

```
React app
  │
  ├── GET /manifest        → Lambda → DynamoDB scan (deleted=false only)
  │                                   returns flat list of paths + metadata
  │
  └── GET /file-url?path=  → Lambda → presigned S3 GET URL
                                       browser fetches file directly from S3
```

**`GET /manifest`** returns the full path list with metadata (hash, size,
content type, timestamp). The React app builds the directory tree client-side
from this flat list — splitting each path on `/` and folding into a nested
structure for the disclosure widget. No separate "list directory" endpoint is
needed.

**`GET /file-url?path=`** returns a short-lived presigned S3 URL for a single
file. The file is fetched lazily — only when the user clicks it in the tree.
File bytes never pass through Lambda or API Gateway.

Soft-deleted entries are filtered out of `/manifest` by the Lambda handler.
The web app never sees them.

---

## Storage

| Resource | Purpose |
|---|---|
| S3 bucket | File content. Object key = relative path (`recipes/lentil_soup.md`). Versioning enabled — deletions are recoverable. |
| DynamoDB table | Manifest. Partition key: `path`. Attributes: `sha256`, `size_bytes`, `content_type`, `modified_time`, `deleted`, `deleted_at`. On-demand billing. |

Both resources use `RemovalPolicy.RETAIN` — destroying the CDK stack will not
delete the bucket or table or their contents.

---

## Repository Layout

```
DocSearch/
  README.md                  ← you are here

  go_files/                  ← CLI tool (Go)
    main.go
    go.mod
    internal/
      localfs/               ← walks local directory tree, computes hashes
      manifest/              ← fetches DynamoDB manifest
      syncer/                ← diff logic and S3/DynamoDB write operations

  cdk/                       ← infrastructure (Python CDK)
    app.py
    requirements.txt
    cdk.json
    docsearch_cdk/
      docsearch_stack.py     ← S3 bucket + DynamoDB table (storage layer)
                               Lambda + API Gateway added here later
```

---

## CLI Usage

```bash
export DOCSEARCH_BUCKET=<bucket name from cdk deploy output>
export DOCSEARCH_TABLE=<table name from cdk deploy output>

docsearch-cli status              # show pending changes, make no changes
docsearch-cli sync                # apply pending changes

docsearch-cli status -root ~/Docs # explicit root (default: $DOCSEARCH_ROOT or ./Docs)
docsearch-cli sync   -root ~/Docs
```

Output markers:
- `U  path` — file will be uploaded (new, changed, or previously deleted and now restored)
- `D  path` — file will be soft-deleted (present in manifest, absent locally)

---

## Infrastructure Setup

Requires the [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html)
and an AWS account bootstrapped for CDK (`cdk bootstrap`).

```bash
cd cdk/
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cdk deploy
```

After deploy, copy the printed `BucketName` and `TableName` output values
into `DOCSEARCH_BUCKET` and `DOCSEARCH_TABLE`.

---

## What Is Not Built Yet

- **Lambda functions and API Gateway** — the read path exists in design but
  not yet in code. The CLI is fully functional without them.
- **React web frontend** — will consume `/manifest` and `/file-url` once the
  read API is deployed. The tree view will use a disclosure widget; files will
  be fetched and rendered lazily on click.
