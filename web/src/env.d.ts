/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL of the DocSearch HTTP API, e.g. the ApiUrl output of
  // DocSearchWebStack. Set for dev only, in .env.development.local
  // (git-ignored). Unset in the hosted build, which uses its own origin.
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
