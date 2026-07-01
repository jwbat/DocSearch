
The seam between "CLI-only" and "web app" sits almost entirely at the auth layer  — and that's a layer that can be bolted on without touching the core logic. The ingest pipeline, Lambda handler, cosine similarity code, DynamoDB schema, S3 vector store format — none of that has any opinion about whether the caller is a terminal or a browser.  
The Lambda just sees an HTTP request hit API Gateway either way.

So the natural sequence is:

1. **Build and validate the core system first**, CLI-only, no Cognito, minimal or no auth (maybe just an API key on API Gateway, or nothing if you're testing via direct Lambda invoke during early development). This lets you iterate fast on the part that actually matters right now — chunking strategy, embedding quality, retrieval relevance, whether your top-N results are actually useful. That's the real unknown in this project. Auth is not an unknown; it's a known, well-documented pattern you can drop in later without re-deriving anything.

2. **Once retrieval quality and the Lambda/API design feel solid**, add the Cognito User Pool + authorizer in front of the existing API Gateway routes, add CORS headers to your Lambda responses, and build a thin web frontend that calls the same endpoints your CLI already calls. Nothing about the Lambda internals changes — you're inserting a gate in front of routes that already exist and already work.

This also has a nice side effect for you specifically: it keeps the project's two genuinely separate concerns — "does semantic search over my notes work well" and "how do people authenticate to a web service" — from getting tangled together while you're still learning Go and CDK. Debugging a bad retrieval result is hard enough without also wondering whether a JWT validation issue is masking it.

One small thing worth doing even in phase 1, since it costs nothing now and saves a rewrite later: define your API Gateway routes and request/response JSON shapes as if a browser were going to call them eventually (clean REST-ish paths, JSON in/out, no CLI-specific assumptions baked into the wire format). That way phase 2 is purely additive — new auth layer, new frontend — rather than a refactor of routes you designed around being your only caller.
