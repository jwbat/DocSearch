# Doc Search — CDK

Two stacks, both pinned to one account and `us-west-2` in `app.py`.

**`DocSearchStack`** — storage, used by the CLI and read by the API:

- An S3 bucket (versioned, encrypted, all public access blocked) — holds
  file content, keyed by path. A lifecycle rule expires noncurrent
  versions (overwritten or deleted content) after 30 days, so a deleted
  file can be recovered for 30 days and no longer than that.
- A DynamoDB table (`path` as partition key, on-demand billing) — holds
  the manifest (hash, size, content type, soft-delete flag).

Both resources are set to `RemovalPolicy.RETAIN` — deleting the stack
(`cdk destroy`) won't delete the bucket or table or their contents. This
is intentional: the manifest table and the bucket are the only copies of
your synced documents. If you want full teardown during early
experimentation, change `removal_policy` to `RemovalPolicy.DESTROY` in
`docsearch_cdk/docsearch_stack.py` — just switch it back before you start
relying on this for anything real.

**`DocSearchWebStack`** — the read path (`docsearch_cdk/web_stack.py`):

- A Go Lambda (`../go_files/cmd/api-lambda`) behind an HTTP API (v2),
  serving `GET /manifest` and `GET /file-url`. It has read-only access to
  the bucket and table. No authorizer; stage throttling is the guard.
- A private site bucket holding the built React app (`../web`), and a
  CloudFront distribution in front of it (Origin Access Control). CloudFront
  also forwards `/manifest` and `/file-url` to the HTTP API, uncached, so
  the hosted app calls the API at its own origin.
- A `BucketDeployment` that uploads the app and invalidates CloudFront on
  every deploy.

Everything in this stack is disposable (the site bucket is
`RemovalPolicy.DESTROY` with auto-delete). The CLI (in `../go_files`) still
talks to S3 and DynamoDB directly with your own AWS credentials; only the
web frontend goes through the API.

**Builds happen during synth.** CDK builds the Lambda with the local Go
toolchain and the frontend with the local npm (`npm run build` in `../web`,
which needs `npm install` there first). Each falls back to a Docker build
if the tool isn't installed.

**CORS origins** come from `FRONTEND_ORIGINS` in `app.py`, shared by the
docs bucket and the API: the Vite dev server (`localhost` and the Mac's
`.local` name) and the CloudFront domain. The CloudFront domain is written
out by hand because passing it from `DocSearchWebStack` back to the docs
bucket would be a cross-stack cycle.

## Setup

```bash
python3 -m venv venv
source venv/bin/activate       # venv\Scripts\activate on Windows
pip install -r requirements.txt

brew install aws-cdk
which cdk
```

If you haven't used CDK in this AWS account/region before:

```bash
cdk bootstrap
```

## Deploy

```bash
cdk diff --all                          # see what would change, good habit before every deploy
AWS_PROFILE=personal cdk deploy --all   # DocSearchStack first, then DocSearchWebStack
```

Outputs:

- `DocSearchStack`: `BucketName` and `TableName` — CDK-generated names with
  a random suffix. Copy them into the CLI's environment:

  ```bash
  export DOCSEARCH_BUCKET=<value of BucketName output>
  export DOCSEARCH_TABLE=<value of TableName output>
  ```

- `DocSearchWebStack`: `SiteUrl` (the web app) and `ApiUrl` (the API's own
  URL, used only as `VITE_API_URL` for the dev server).

## Validate without deploying

```bash
cdk synth             # renders the CloudFormation templates, catches config errors
./synth.sh            # writes storage.yaml and web.yaml, for reviewing diffs in git
```
