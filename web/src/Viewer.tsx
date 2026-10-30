import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import { getFileUrl, type ManifestItem } from './api'
import './Viewer.css'
import './highlight.css'

type State =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string }

// Inline HTML in markdown (<br>, <sup>, <details>, …) renders the way it does
// on GitHub: rehype-raw parses it, and rehype-sanitize then strips anything
// unsafe (scripts, event handlers, iframes) using GitHub's own allowlist.
//
// Fenced code blocks with a language tag (```python, ```bash, ```go, …) are
// then syntax-highlighted by rehype-highlight; untagged blocks stay plain.
//
// Order matters: sanitize runs after raw, and highlight runs last so the
// sanitizer doesn't strip its class names.
const rehypePlugins = [rehypeRaw, rehypeSanitize, rehypeHighlight]

function isMarkdown(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/markdown')
}

// Viewer fetches and renders one file. Nothing is fetched until a file is
// selected: first a presigned URL from the API, then the content straight
// from S3. The parent keys this component by path, so selecting another
// file starts over with fresh state.
//
// Only markdown renders so far; other types get a placeholder.
export function Viewer({ item }: { item: ManifestItem }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    if (!isMarkdown(item)) return
    const controller = new AbortController()
    const { signal } = controller

    getFileUrl(item.path, signal)
      .then(({ url }) => fetch(url, { signal }))
      .then((res) => {
        if (!res.ok) throw new Error(`Couldn't load the file (HTTP ${res.status})`)
        return res.text()
      })
      .then((text) => setState({ status: 'ready', text }))
      .catch((err: unknown) => {
        if (signal.aborted) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [item])

  if (!isMarkdown(item)) {
    return <p className="placeholder">No preview for this file type yet.</p>
  }
  if (state.status === 'loading') return <p className="placeholder">Loading…</p>
  if (state.status === 'error') return <p className="viewer-error">{state.message}</p>

  return (
    <article className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
        {state.text}
      </Markdown>
    </article>
  )
}
