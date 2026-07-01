S3 as the vector store (JSON), DynamoDB for metadata, Bedrock/Titan V2 for embeddings, Go Lambda, CDK for infra, CLI first.

## Phase 0 — Infrastructure skeleton (CDK)
Get the empty plumbing deployed before writing any real logic, so every later phase has somewhere to live.
1. CDK app bootstrap (Python or TypeScript CDK — your call, doesn't have to match Go runtime)
2. S3 bucket — versioned, for the vector store JSON + raw doc storage
3. DynamoDB table — metadata (source, date, tags), simple partition key on doc ID
4. IAM roles — Lambda execution role with least-privilege access to S3, DynamoDB, and `bedrock:InvokeModel`
5. Two Lambda function stubs (Go) — `ingest` and `query` — empty handlers just to prove the deploy pipeline works
6. `cdk deploy` end to end with stub handlers, confirm invoke via AWS CLI

This phase exists purely to de-risk CDK/IAM/Bedrock permissions before any business logic depends on them.

## Phase 1 — Ingest pipeline (Go Lambda)
1. Chunking logic — split markdown/text docs into chunks (decide chunk size/overlap strategy)
2. Bedrock client setup — `bedrockruntime` client, `amazon.titan-embed-text-v2:0`, package-level init for warm reuse
3. Embed each chunk → float32 vector
4. Write chunk text + vector to the S3 JSON vector store (append/merge logic — decide whether you rewrite the whole file or shard it)
5. Write doc metadata to DynamoDB
6. Test by invoking `ingest` directly via AWS CLI with a sample doc — no API Gateway yet

## Phase 2 — Query pipeline (Go Lambda)
1. Load vector store from S3 into a package-level slice on cold start (cache across warm invocations)
2. Embed the incoming query string via the same Titan model
3. Cosine similarity in Go against every stored vector — brute force, fine at this scale
4. Return top-N chunks (text + score + doc ID)
5. Test directly via `aws lambda invoke` with a hardcoded query payload

At this point you have a fully working ingest→query loop with zero HTTP surface — good checkpoint to validate retrieval quality before adding more moving parts.

## Phase 3 — Full-document retrieval
1. Given a chosen chunk's doc ID, fetch the full document — decide now whether full docs live in S3 (separate key per doc) or get reconstructed from DynamoDB metadata pointing back to S3
2. Add this as a second step in the query Lambda, or a separate `getDocument` Lambda — depends on whether you want one round trip or two
3. Wire this into the query flow: top chunk → resolve doc ID → fetch full doc → return both chunk and full doc

## Phase 4 — API Gateway front door
1. Add API Gateway REST (or HTTP) API in CDK, routes: `POST /ingest`, `POST /query`
2. Lambda proxy integration for both functions
3. No API key for now, as planned — but still worth defining the JSON request/response shape cleanly now, since you already know a browser client may call this later
4. Test via `curl` against the deployed API Gateway URL

## Phase 5 — CLI front end
1. Simple Go CLI (or shell script) that POSTs to API Gateway — `ingest <file>` and `query "<text>"` commands
2. Pretty-print results: chunk text, score, source doc, snippet of full doc
3. This becomes your daily-driver interface for the rest of development — every later refinement (chunking strategy, ranking, metadata filters) gets validated through this CLI

## Phase 6 — Iteration / quality pass
Once the loop is fully working end-to-end via CLI:
1. Tune chunk size/overlap based on real retrieval results
2. Add metadata filtering (tags, date ranges) as DynamoDB queries that narrow the candidate set before cosine similarity
3. Optional: pass top chunks to an LLM for answer synthesis rather than raw chunk dump
4. Add basic logging/observability (CloudWatch) now that there's real usage to observe

## Phase 7 — Later: API key / auth / web layer (deferred, additive only)
Already discussed and confirmed as a separate later phase — no changes needed to Lambda logic, just:
1. API Gateway API key or Cognito User Pool + JWT authorizer
2. CORS headers
3. Web frontend calling the same routes the CLI already validated

---

The key sequencing logic: **Phase 0–2 prove the core retrieval loop works in isolation** before any HTTP surface exists, so when something doesn't retrieve well you know it's the embedding/chunking/similarity logic, not network plumbing. API Gateway and the CLI come after the brains are proven, not before.

Want me to start scaffolding the actual CDK app for Phase 0, or sketch the Go chunking/embedding code for Phase 1 first?
