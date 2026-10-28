# DocSearch Read Path — Implementation Outline

Scope: a Go Lambda function, API Gateway, and the React web frontend, as
described in the "Read Path" section of `README.md`. The write path (CLI, S3,
DynamoDB) already exists and is not changed except where noted.

**Status (2026-10-28):** Phases 1–4 are done and deployed. Next is Phase 5:
`web/src/App.tsx` is still the Phase 4 placeholder that lists top-level
folders. Run `npm run dev` in `web/` and open
`http://jamess-macbook-pro.local:5173/` on the iPhone. The IP address won't
work, because it isn't an allowed CORS origin.

The order goes from the bottom of the stack up. Each layer is tested before
the next one is built on top of it, so the React app is only started once
there is a real, deployed API for it to call.

---

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | API access control | No auth. An unguessable URL plus API Gateway throttling is enough; the docs aren't sensitive. |
| 2 | Lambda code and build | One Lambda serves both routes, switching on the request path. Its entry point is `go_files/cmd/api-lambda/` and it shares `internal/`. CDK builds it with Docker bundling. |
| 3 | API Gateway flavor | HTTP API (v2). |
| 4 | Frontend hosting | S3 + CloudFront, defined in CDK. |
| 5 | Deploy target | `AWS_PROFILE=personal`, `us-west-2`. Pin `env=cdk.Environment(...)` in `app.py`. |
| 6 | Frontend tooling | Vite + React + TypeScript, plain CSS, responsive and mobile-friendly. Markdown is rendered with `react-markdown` + `remark-gfm`, with syntax highlighting for fenced code blocks (`` ```python ``). Relative images in markdown load through `/file-url`. Relative links open the linked file in the viewer, and the browser Back button returns to the previous page. |
| 7 | Search | Out of scope. Navigation is a drill-down disclosure tree only, with no search and no filename filter. |
| 8 | File types | Markdown, PDF, images (PNG, JPG), plain text. No audio. Many hundreds of files eventually, so each file is fetched lazily when clicked. |
| 9 | Stack layout | Lambda, API, and frontend hosting go in a new stack, `DocSearchWebStack`. The existing `DocSearchStack` stays the storage layer. |

---

## Phase 1 — Lambda (Go), local only

1. **Code layout.** Add one Lambda entry point to the existing Go module:
   ```
   go_files/
     cmd/
       api-lambda/main.go  ← wires AWS clients, starts the Lambda runtime
     internal/
       api/                ← router, route handlers, JSON response shapes
   ```
   The router dispatches on method and path: `GET /manifest` and
   `GET /file-url`. Anything else returns 404.
   The CLI's `main.go` stays where it is. The Dockerfile and `compose.yaml`
   still build only the CLI.
2. **Dependencies.** Add `github.com/aws/aws-lambda-go` for the events types
   and the Lambda runtime. S3 presigning uses the existing `service/s3`
   package.
3. **`GET /manifest` handler.**
   - Scan the DynamoDB table with pagination (follow `LastEvaluatedKey`).
     Hundreds of items fits comfortably in a single response.
   - Filter out `deleted = true` items.
   - Return a JSON array of `path`, `sha256`, `size_bytes`, `content_type`,
     `modified_time`.
   - Read the table name from the `DOCSEARCH_TABLE` environment variable, set
     by CDK.
4. **`GET /file-url?path=` handler.**
   - Validate `path`: it must be present, with no leading `/` and no `..`.
   - Check that the path is in the manifest and not soft-deleted, so the API
     can't be used to presign arbitrary keys or deleted objects. This is a
     single DynamoDB `GetItem` on `path` (the partition key), not a scan.
   - Return `{ "url": "<presigned GET>", "expires_in": <seconds> }` with a
     short expiry (e.g. 5 minutes). Set `ResponseContentType` from the
     manifest so PDFs and images render inline in the browser.
   - Read the bucket and table names from the `DOCSEARCH_BUCKET` and
     `DOCSEARCH_TABLE` environment variables.
5. **Errors.** Use one JSON error body shape with 400 / 404 / 500 status
   codes.
6. **Unit tests.** Test the handler logic against a small interface for the
   DynamoDB client, with no AWS dependency, in the same style as
   `internal/syncer`. Cover deleted-item filtering, pagination, path
   validation, unknown routes, and the not-found case. `go test ./...` must
   pass.
   - Presigning with `s3.PresignClient` signs locally and makes no network
     call, so the `/file-url` tests use the real presigner with static fake
     credentials and check the URL's key, expiry, and response content type.
     Only DynamoDB needs a fake.

## Phase 2 — Infrastructure (CDK), synth only

7. **Pin the environment.** In `app.py`, set
   `env=cdk.Environment(account=<personal account>, region="us-west-2")` on
   both stacks. Before pinning, confirm the account ID with
   `aws sts get-caller-identity --profile personal`, and confirm with
   `aws dynamodb describe-table` that the existing table lives there.
8. **New stack.** Add `docsearch_cdk/web_stack.py` containing
   `DocSearchWebStack`. In `app.py`, pass it the storage stack's `bucket` and
   `table` as cross-stack references.
9. **Lambda build.** Use CDK `Code.from_asset` with Docker bundling, using a
   `golang` image, to cross-compile `cmd/api-lambda` as `bootstrap` for
   `provided.al2023` on `arm64` (`GOOS=linux GOARCH=arm64 CGO_ENABLED=0`).
   The asset source is `go_files/`. Bundling tries the local Go toolchain
   first and falls back to Docker only if `go` isn't installed, so synth and
   deploy don't need a running Docker daemon.
10. **Lambda construct.**
    - `ApiFunction`: env `DOCSEARCH_TABLE` and `DOCSEARCH_BUCKET`. IAM is
      `table.grant_read_data` and `bucket.grant_read`. The role needs
      `s3:GetObject` because the presigned URL is signed with its
      credentials.
    - Modest memory and timeout settings. Set log retention explicitly so logs
      don't accumulate forever.
11. **HTTP API (v2).**
    - Routes: `GET /manifest` and `GET /file-url`, both → ApiFunction.
    - CORS limited to `http://localhost:5173`,
      `http://jamess-macbook-pro.local:5173` (the dev server as reached from
      an iPhone on the LAN), and the CloudFront origin. All three come from
      `FRONTEND_ORIGINS` in `app.py`. The
      CloudFront origin is added in Phase 6.
    - No authorizer. Set default-stage throttling (rate and burst limits) as
      the cost and abuse guard.
12. **Docs bucket CORS.** The browser `fetch()`es markdown and plain-text
    files from the presigned URL so they can render in-page, so the docs
    bucket needs a `GET`-only CORS rule for the frontend origins. This is the
    one change to `DocSearchStack`. It only touches properties: the bucket is
    not replaced and stays `RETAIN`.
13. **Outputs.** Add `ApiUrl` as a `CfnOutput` on `DocSearchWebStack`.
14. **`cdk synth` and `cdk diff`.** Review the diff together and confirm the
    storage bucket and table are not being replaced. No deploy yet.

## Phase 3 — Deploy and verify the API

15. **`cdk deploy --all`.** Only after explicit confirmation, with
    `AWS_PROFILE=personal`.
16. **Smoke test with `curl`:**
    - `/manifest` returns live entries and no soft-deleted ones.
    - `/file-url?path=<real file>` returns a URL, and `curl` on that URL
      returns the file bytes.
    - A bad or missing `path`, a path containing `..`, and a deleted path are
      all rejected.
    - A CORS preflight from `localhost:5173` succeeds.

## Phase 4 — React frontend: scaffold and data layer

17. **Scaffold** `web/` at the repo root with Vite + React + TypeScript and
    plain CSS. Read the API base URL from `VITE_API_URL` in `.env.local`,
    which is git-ignored.
18. **API client module.** Typed `getManifest()` and `getFileUrl(path)`.
19. **Tree builder.** A pure function that turns the flat path list into a
    nested folder/file tree: split each path on `/`, fold into nodes, sort
    folders before files and then alphabetically. Unit tested with Vitest.

## Phase 5 — React frontend: UI (iterative, together, locally)

20. **First pass, deliberately plain:**
    - Disclosure-widget tree that drills down into folders on click.
    - Lazy viewer: nothing is fetched until a file is clicked. Then call
      `/file-url` and render by `content_type`:
      - Markdown: fetch the text and render it with `react-markdown` +
        `remark-gfm` (tables, task lists, strikethrough).
        - **Syntax highlighting:** fenced code blocks with a language tag
          (`` ```python ``, `` ```go ``, …) are highlighted with
          `rehype-highlight`, which uses highlight.js language grammars and a
          CSS theme. Blocks without a tag render as plain monospace.
        - **Images:** a custom `img` component resolves relative `src` against
          the markdown file's directory, then fetches a presigned URL from
          `/file-url` and renders it. Absolute `http(s)` images load as-is.
        - **Links:** a custom `a` component resolves relative links the same
          way and opens the target in the viewer through the app's
          hash-based routing, so each link adds a browser history entry. Back
          returns to the containing page. External links open in a new tab.
      - Plain text: fetch the text and show it in a `<pre>`.
      - PNG/JPG: `<img src={url}>`.
      - PDF: `<iframe>`/`<object>`, with an "open in new tab" link as the
        fallback. Mobile browsers handle inline PDFs inconsistently.
    - **Hash routing:** the selected file lives in the URL, e.g.
      `#/recipes/lentil_soup.md`, so browser Back/Forward move between viewed
      files. Opening a file from the tree also expands the folders on its
      path. This routing is needed for markdown links to work with Back, and
      it makes deep links possible.
    - Loading, error, and empty states.
    - Responsive from the start. Tree and viewer sit side by side on wide
      screens. On narrow screens they stack, or the tree becomes a drawer.
21. **Iterate on look and behavior** together via `npm run dev`. Likely
    topics: layout, typography, the code highlighting theme (including
    light/dark), tap targets on mobile, and showing metadata (size, modified
    time).

## Phase 6 — Hosting and docs

22. **Frontend hosting** in `DocSearchWebStack`:
    - A private S3 site bucket and a CloudFront distribution using Origin
      Access Control, with the default root object set to `index.html`.
    - Deploy the output of `npm run build` (`web/dist`) with
      `BucketDeployment`.
    - Give the build the API URL. Either set `VITE_API_URL` at build time, or
      have `BucketDeployment` write a `config.json` from the `ApiUrl` value so
      the bundle doesn't need rebuilding per environment.
    - Add the CloudFront origin to the API CORS rules and the docs bucket CORS
      rules.
    - Confirm before running `cdk deploy`.
23. **Update docs.**
    - `README.md`: move the read path out of "TODO" and "What Is Not Built
      Yet", note that search is not planned, describe the two stacks, and add
      build, deploy, and dev instructions for the Lambda and `web/`.
    - `cdk/CLAUDE.md`: note the second stack and that `app.py` now pins
      account and region.
    - `go_files/CLAUDE.md`: note that the Lambda binary is a CDK build
      artifact and is *not* moved to `~/.local/bin` the way the CLI is.

---

## Open Questions

None. All decisions are recorded in the table at the top.
