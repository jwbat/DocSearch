# the data structure both Lambdas (`ingest` and `query`) need to agree on.

## Single file vs. sharded

At "low thousands of chunks," a single JSON file is genuinely fine — you don't need to shard by doc or by date. Simpler is better here: one S3 key, e.g. `vector-store/index.json`, that gets read whole into memory on Lambda cold start and rewritten whole (or appended-to-then-rewritten) on ingest. A few thousand chunks × 1024 floats × 4 bytes ≈ low tens of MB — trivial for Lambda memory and S3 GET latency.

## Shape of the file

A flat array of chunk records is the natural fit, since query time just wants "iterate every chunk, compute cosine similarity":

```json
[
  {
    "chunk_id": "f3a1c2d4-0001",
    "doc_id": "f3a1c2d4",
    "chunk_index": 0,
    "text": "The actual chunk text, used for display and for...",
    "vector": [0.0123, -0.0456, 0.0789, ...],
    "char_start": 0,
    "char_end": 842
  },
  {
    "chunk_id": "f3a1c2d4-0002",
    "doc_id": "f3a1c2d4",
    "chunk_index": 1,
    "text": "...",
    "vector": [...],
    "char_start": 800,
    "char_end": 1640
  }
]
```

Field-by-field reasoning:

- **`chunk_id`** — unique key for this chunk, useful if you ever want to delete/update a single chunk without touching its siblings.
- **`doc_id`** — the link back to DynamoDB metadata and to the full document in S3. This is the field Phase 3 (full-doc retrieval) hinges on.
- **`chunk_index`** — chunk's position within its source doc. Handy for reconstructing order, or for "grab the chunk before/after this one for more context" later.
- **`text`** — store the raw chunk text right here, not just the vector. You want this back immediately at query time without a second fetch.
- **`vector`** — `[]float32` in Go, 1024 elements for Titan V2.
- **`char_start` / `char_end`** — optional, but cheap insurance if you ever want to highlight or re-chunk later.

## Go-side representation

```go
type Chunk struct {
    ChunkID    string    `json:"chunk_id"`
    DocID      string    `json:"doc_id"`
    ChunkIndex int       `json:"chunk_index"`
    Text       string    `json:"text"`
    Vector     []float32 `json:"vector"`
    CharStart  int       `json:"char_start"`
    CharEnd    int       `json:"char_end"`
}

var vectorStore []Chunk // package-level, populated on cold start
```

This is exactly the package-level slice you cache across warm invocations — load once, reuse on every warm query.

## Ingest-time update strategy

Since it's one file, the ingest Lambda's update flow is: GET the existing JSON from S3 → unmarshal into `[]Chunk` → append new doc's chunks → marshal → PUT back to S3, overwriting the same key. Not transactional, but at personal-corpus scale and single-user ingest cadence, that's a non-issue. If you ever wanted concurrent-safe writes you'd reach for S3 conditional writes (ETag match) or DynamoDB instead — but that's solving a problem you don't have yet.

One thing worth deciding now: do you want **versioning on** for that bucket (you already have it in Phase 0) so a bad ingest write doesn't silently corrupt your only copy of the index? I'd say yes — it's free insurance for exactly this kind of overwrite-the-whole-file pattern.
