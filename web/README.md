# docsearch-web

Read-only web frontend for Doc Search: a drill-down tree of the synced
documents with an in-page viewer. Vite + React + TypeScript, plain CSS.
It talks only to the DocSearch HTTP API (`GET /manifest`,
`GET /file-url`) and never holds AWS credentials.

## Setup

Requires Node 20.19+ or 22.12+ (Vite 8).

```
npm install
cp .env.example .env.local   # then set VITE_API_URL to the ApiUrl stack output
```

## Commands

```
npm run dev     # dev server at http://localhost:5173 (the origin the API's CORS allows)
npm test        # unit tests (Vitest), no network
npm run build   # type-check and build to dist/
npm run lint    # oxlint
```

## Layout

- `src/api.ts` — typed API client (`getManifest`, `getFileUrl`)
- `src/tree.ts` — turns the flat manifest into the folder/file tree
