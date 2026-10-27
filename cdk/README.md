# Doc Search — CDK (storage layer)

This stack currently creates only the two storage resources the CLI needs:

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

No Lambda or API Gateway yet — the CLI (in `../go_files`) talks to S3 and
DynamoDB directly with your own AWS credentials. Those pieces get added
once the read-only web frontend needs a way in without holding
credentials itself.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate      # .venv\Scripts\activate on Windows
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
cdk diff      # see what would change, good habit before every deploy
cdk deploy
```

`cdk deploy` will print the real bucket and table names as outputs
(`BucketName`, `TableName`) — these are CDK-generated names with a random
suffix, not anything you choose by hand. Copy them into the CLI's
environment:

```bash
export DOCSEARCH_BUCKET=<value of BucketName output>
export DOCSEARCH_TABLE=<value of TableName output>
```

## Validate without deploying

```bash
cdk synth      # renders the CloudFormation template, catches config errors
```

This was run and checked during development — `cdk synth` produces
exactly one `AWS::S3::Bucket`, one `AWS::DynamoDB::Table`, and the two
expected outputs, with the properties above confirmed in the synthesized
template.
