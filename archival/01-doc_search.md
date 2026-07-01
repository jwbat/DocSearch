Project: Personal Document Search — AWS + Go

A semantic search tool for personal markdown notes and documents. The architecture uses AWS API Gateway, AWS Lambda (Go), S3 for storage, and a local CLI as the front end.

Ingest flow:

1.  Documents are chunked and each chunk is sent to an embedding model (Voyage AI, Anthropic API, or *AWS Bedrock*) which returns a float vector encoding semantic meaning
2.  Chunk text and vectors are stored in S3 as a JSON file (the vector store)
3.  Document metadata (source, date, tags) stored in DynamoDB

Query flow:

1.  CLI sends a query string to API Gateway → Lambda

2.  Lambda loads the vector store from S3 into a package-level Go slice (cached across warm invocations for performance)

3.  The query string is embedded using the same model

4.  Cosine similarity is computed in Go between the query vector 
      and every stored vector — fast enough at this scale (low thousands of chunks)
      to do brute-force with no vector DB needed

5.  Top N matching chunks are returned, optionally passed to an LLM for answer synthesis


Key design decisions:
- No dedicated vector database — brute-force cosine similarity in Go is sufficient at personal-corpus scale
- S3 as source of truth for the vector store; in-memory package-level variable as warm cache in Lambda
- DynamoDB for structured metadata queries only
- Embeddings are dense float64 slices, typically 768–1536 dimensions depending on model
- Language / stack: Go (Lambda), AWS CDK for infrastructure, CLI front end (Go or shell)

Staying inside AWS with IAM auth and no floating API keys,
Titan Embeddings V2 at 1024 dimensions is a solid,  low-friction choice.  

