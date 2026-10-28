/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Base URL of the DocSearch HTTP API, e.g. the ApiUrl output of
  // DocSearchWebStack. Set in .env.local (git-ignored).
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
