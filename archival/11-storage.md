
**S3 as the content store.** One bucket, and the object key *is* the path — `coding_notes/Go/commands.md`, `recipes/black_bean_soup.md`, etc. This means your local directory tree maps directly onto S3 keys with no translation layer. Turn on versioning on the bucket; it gives you free revision history (every save creates a new version) at essentially no cost for text files, which is nice insurance while you're iterating on the system itself.

**DynamoDB as the manifest/index.** This is the piece that makes the "diff" sync work well. One table, partition key = full path, with attributes like `sha256`, `size_bytes`, `modified_time`, `content_type`. The CLI walks your local `Docs/` tree, hashes every file, and compares against this manifest rather than against S3 directly — querying DynamoDB for the whole manifest is fast and cheap, whereas doing a `ListObjectsV2` walk every time you sync starts to feel slow once you have hundreds of files.

**Sync flow** (the diff behavior you want):
1. CLI computes local hashes for everything under `Docs/`.
2. CLI hits `GET /manifest` → Lambda returns the full `{path: {hash, size, modified}}` map from DynamoDB.
3. CLI diffs locally — anything new or hash-mismatched goes in an upload queue. Everything else is skipped, so a one-file change really does only send that one file.
4. For each file that needs uploading, rather than routing file bytes through API Gateway → Lambda (which hits the 10MB payload ceiling and is just unnecessary hops for something S3 is built for), the Lambda returns a **presigned S3 PUT URL**, and the CLI uploads directly to S3.
5. An S3 event notification fires a second Lambda on object-create, which updates the DynamoDB record (hash, size, mtime) — so the manifest stays authoritative without your sync client needing a separate "confirm" call.

This keeps Lambda in Go end-to-end (manifest handler, presign handler, S3-event handler) and API Gateway exposing just two routes for now: `GET /manifest` and `POST /presign`. Reads later for the React frontend would layer on naturally — either presigned GET URLs for raw file fetch, or a `GET /files/{path}` route if you want Lambda to do any rendering/transformation server-side first.

## Deletions
Soft-delete in DynamoDB is the better default here, and it actually pairs naturally with the S3 versioning already turned on.

Reasoning: when you delete an object from a versioned S3 bucket, the object isn't actually destroyed — S3 just writes a delete marker as the new "current" version, with all prior versions still recoverable. If you hard-delete the DynamoDB record at the same time, you break that symmetry: the content history still exists in S3, but the manifest has amnesia about the path ever existing. That makes "did I have a file here, and when did it disappear" unanswerable without digging through raw S3 version listings.

So I'd add a `deleted` (bool) and `deleted_at` (timestamp) attribute to the DynamoDB item rather than removing the row. Concretely, the delete flow becomes:

1. CLI's diff pass also checks the reverse direction — any path present in the manifest but missing locally goes into a delete batch.
2. CLI calls something like `POST /delete` with the path.
3. Lambda issues `DeleteObject` on the S3 key (since versioning is on, this just adds a delete marker — nothing is actually destroyed).
4. Lambda updates the DynamoDB item: `deleted = true`, `deleted_at = <timestamp>`, but leaves `sha256`/`size`/etc. as they were on last sync.
5. The `GET /manifest` handler filters out `deleted = true` items by default, so your CLI's diff logic just sees those paths as "doesn't exist" and will treat recreating the file as a fresh upload — which is the right behavior.

This costs you basically nothing (DynamoDB items are a few hundred bytes) and gives you a real undo path later if you ever want a "restore deleted file" command — pull the last known S3 version for that key and flip `deleted` back to false. Whether you ever build that command is optional; the point is soft-delete keeps the option open at zero cost, whereas hard-delete forecloses it.


### storage layer

- **S3**: content store, key = path, versioning on
- **DynamoDB**: manifest with soft-delete (`deleted`, `deleted_at`), filtered out of `GET /manifest`
- **API Gateway + Go Lambda**: `GET /manifest`, `POST /presign` (upload), `POST /delete`
- **S3 event notification → Lambda**: keeps the manifest's hash/size/mtime in sync on actual object writes

Next natural piece to nail down is the **CLI sync command's local-side bookkeeping** — specifically, does it re-walk and re-hash your entire `Docs/` tree on every run, or do you want it to cache local state (e.g., a `.doc_sync_state.json` or similar) so it can skip re-hashing files whose mtime hasn't changed? With a personal doc tree this is probably premature optimization at first, but it's worth deciding now since it shapes whether the CLI needs any local persistence at all, or stays fully stateless and rebuilds its picture from the DynamoDB manifest every time.
