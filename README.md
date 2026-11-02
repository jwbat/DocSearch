# DocSearch

A personal document storage and retrieval system built on AWS. Documents live
in a local directory tree, are synced to S3 by a CLI tool, and are browsable
via a read-only web frontend hosted on CloudFront.

---

## Architecture Overview

```
Local Docs/          CLI (Go)           AWS
─────────────        ────────           ───────────────────────────
coding_notes/    →   hash & diff   →    S3 bucket (content)
  Go/                                   DynamoDB table (manifest)
  Python/                                     ↑ read-only
recipes/                                Lambda (Go) + HTTP API
music/                                        ↑
...                                     CloudFront ← browser (React app)
```

There are two distinct paths through the system — a **write path** used only
by the CLI, and a **read path** used only by the web frontend. They share the
same S3 bucket and DynamoDB table but are otherwise independent.

---

## Write Path (CLI only)

The CLI is the sole writer. It runs locally, requiring AWS credentials, and
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

The web frontend is read-only and holds no AWS credentials. One CloudFront
distribution serves both the React app and the API, so the app calls the API
at its own origin and needs no API URL configured.

```
browser ── CloudFront ─┬─ /*           → S3 site bucket (built React app)
                       ├─ /manifest    → HTTP API → Lambda → DynamoDB scan
                       │                  (deleted=false only; flat list of
                       │                  paths + metadata)
                       └─ /file-url    → HTTP API → Lambda → presigned S3 GET URL

browser ── presigned URL ──→ S3 docs bucket (file bytes, fetched directly)
```

**`GET /manifest`** returns the full path list with metadata (hash, size,
content type, timestamp). The React app builds the directory tree client-side
from this flat list — splitting each path on `/` and folding into a nested
structure for the disclosure widget. No separate "list directory" endpoint is
needed.

**`GET /file-url?path=`** returns a presigned S3 URL, valid for 5 minutes,
for a single file. The file is fetched lazily — only when the user clicks it
in the tree. File bytes never pass through Lambda, API Gateway, or
CloudFront.

Soft-deleted entries are filtered out of `/manifest` by the Lambda handler.
The web app never sees them.

There is no authentication: the docs aren't sensitive, and the unguessable
URL plus API Gateway throttling (20 requests/s, burst 50) is the guard.
CloudFront doesn't cache the API routes.

**Viewer:** markdown renders in-page (GitHub-flavored, with syntax-highlighted
code blocks; `<span>`/`<div>` may carry a `style`, e.g.
`<span style="color: #ff1522">`), and so does plain text (`.txt`, monospace). Images (PNG, JPG,
GIF, WebP, SVG) show inline, scaled to fit, with an "Open full size" button. PDFs
open in a new browser tab via an "Open file" button, so the browser's own PDF
viewer handles them.

---

## Storage

| Resource | Purpose |
|---|---|
| S3 bucket | File content. Object key = relative path (`recipes/lentil_soup.md`). Versioning enabled — deletions are recoverable. |
| DynamoDB table | Manifest. Partition key: `path`. Attributes: `sha256`, `size_bytes`, `content_type`, `modified_time`, `deleted`, `deleted_at`. On-demand billing. |

Both resources use `RemovalPolicy.RETAIN` — destroying the CDK stack will not
delete the bucket or table or their contents.

### CDK stacks

Both stacks are pinned to one account and `us-west-2` in `cdk/app.py`.

| Stack | Contents |
|---|---|
| `DocSearchStack` | Storage: the docs bucket and the manifest table above. |
| `DocSearchWebStack` | Read path: the API Lambda, the HTTP API, the site bucket, the CloudFront distribution, and the deployment of the built web app. Depends on `DocSearchStack`. Everything here is disposable; redeploying recreates it. |

---

## Repository Layout

```
DocSearch/
  README.md                  ← you are here
  outline.md                 ← read-path implementation plan and progress

  go_files/                  ← Go module: CLI and API Lambda
    main.go                  ← CLI entry point
    cmd/api-lambda/          ← Lambda entry point
    internal/
      api/                   ← /manifest and /file-url handlers
      localfs/               ← walks local directory tree, computes hashes
      manifest/              ← fetches DynamoDB manifest
      syncer/                ← diff logic and S3/DynamoDB write operations

  cdk/                       ← infrastructure (Python CDK)
    app.py                   ← account/region pin, CORS origins, both stacks
    docsearch_cdk/
      docsearch_stack.py     ← DocSearchStack: docs bucket + manifest table
      web_stack.py           ← DocSearchWebStack: Lambda, API, site, CloudFront
    storage.yaml, web.yaml   ← synthesized templates, for review (synth.sh)

  web/                       ← React frontend (Vite + TypeScript)
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

Requires the [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html),
an AWS account bootstrapped for CDK (`cdk bootstrap`), Go (to build the
Lambda; Docker is the fallback), and Node/npm with `npm install` already run
in `web/` (to build the frontend; Docker is the fallback).

```bash
cd cdk/
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
AWS_PROFILE=personal cdk diff           # review first (diffs every stack; no --all needed)
AWS_PROFILE=personal cdk deploy --all   # deploys DocSearchStack, then DocSearchWebStack
```

`cdk deploy --all` builds the Lambda and the web app, uploads the app to the
site bucket, and invalidates CloudFront's cache, so a frontend change only
needs this one command to go live.

Outputs:
- `DocSearchStack`: `BucketName` and `TableName` — copy into
  `DOCSEARCH_BUCKET` and `DOCSEARCH_TABLE` for the CLI.
- `DocSearchWebStack`: `SiteUrl` — the web app
  (https://do5al0s1ozgt6.cloudfront.net); `ApiUrl` — the API's own URL, used
  only by the dev server.

**CORS origins** are listed in `FRONTEND_ORIGINS` in `cdk/app.py`: the dev
server (`localhost` and the Mac's `.local` name, for testing on a phone) and
the CloudFront domain. The CloudFront domain is written out by hand because
passing it from `DocSearchWebStack` to the docs bucket in `DocSearchStack`
would be a cross-stack cycle. It only changes if the distribution is
replaced; then update the list and deploy again.

---

## Web Frontend Development

```bash
cd web/
npm install
cp .env.example .env.development.local   # set VITE_API_URL to the ApiUrl output
npm run dev                              # http://localhost:5173
```

The dev server calls the API at `VITE_API_URL`. Vite reads
`.env.development.local` only in dev mode, so the production build never
contains it. See `web/README.md` for the other commands.

---

## Not Planned / Deferred

- **Search** is not planned. Navigation is the drill-down tree only.
- **Inline PDFs** are not planned: they open in the browser's own viewer.
- **Deferred viewer work:** relative images and links inside markdown. See the Todo list at the top of `outline.md`.
