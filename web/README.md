# docsearch-web

Read-only web frontend for Doc Search: a drill-down tree of the synced
documents with an in-page viewer. Vite + React + TypeScript, plain CSS.
It talks only to the DocSearch HTTP API (`GET /manifest`,
`GET /file-url`) and never holds AWS credentials.

## Setup

Requires Node 20.19+ or 22.12+ (Vite 8).

```
npm install
cp .env.example .env.development.local   # then set VITE_API_URL to the ApiUrl stack output
```

## Commands

```
npm run dev     # dev server at http://localhost:5173 (an origin the API's CORS allows)
npm test        # unit tests (Vitest), no network
npm run build   # type-check and build to dist/
npm run lint    # oxlint
```

## Layout

- `src/api.ts` — typed API client (`getManifest`, `getFileUrl`); uses
  `VITE_API_URL` in dev, the page's own origin when hosted
- `src/tree.ts` — turns the flat manifest into the folder/file tree
- `src/App.tsx` — app shell: header, ← → visited-file arrows, URL-hash
  selection, one- or two-pane layout
- `src/TreeView.tsx` — the disclosure-widget tree
- `src/Viewer.tsx` — fetches the selected file; "Open file" for types
  without a preview
- `src/MarkdownView.tsx` — markdown rendering and syntax highlighting,
  loaded lazily as its own chunk

## Hosting

The built app is served from S3 through CloudFront, which also forwards the
API routes, so the hosted build has no API URL baked in. `cdk deploy --all`
in `../cdk` runs `npm run build` and uploads the result; there is no
separate deploy step here. See `../cdk/README.md`.
