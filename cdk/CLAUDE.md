# cdk/ — agent notes

Storage-layer stack (S3 + DynamoDB) for DocSearch. See `README.md` for setup/deploy
commands and `docsearch_cdk/docsearch_stack.py` for the resource definitions.

## Guardrails

- `cdk deploy` and `cdk destroy` act on real AWS infrastructure. Always confirm
  with the user before running either — never run them as a side effect of some
  other task.
- Both the S3 bucket and DynamoDB table use `RemovalPolicy.RETAIN`. This is
  deliberate (they hold the only copy of synced documents) — don't change it to
  `DESTROY`, even if it looks like a stray setting during cleanup.
- Neither `cdk/app.py` nor the stack pins an explicit account/region
  (`env=cdk.Environment(...)` is commented out). Deploys go to whatever
  account/region is active in the caller's AWS credentials at the time —
  don't assume it's always the same account. This machine has multiple SSO
  profiles configured; if credentials/account matters for what you're doing,
  ask which profile to use rather than guessing.

## Generated / not source

`cdk.out/`, `docsearch_cdk/__pycache__/`, and `venv/` are build artifacts —
don't read them for context and don't edit anything inside them.
