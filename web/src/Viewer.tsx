import { lazy, Suspense, useEffect, useState } from 'react'

import { getFileUrl, type ManifestItem } from './api'
import './Viewer.css'

// The markdown renderer is a separate chunk, fetched on first use.
const MarkdownView = lazy(() => import('./MarkdownView'))

type State =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string }

// Text of every file loaded so far, keyed by its sha256 from the manifest.
// Going back to a file is then instant, and never stale: an edit gives the
// file a new hash, and a reload (which picks up edits) starts an empty cache.
// Markdown is small, so nothing is ever evicted.
const textCache = new Map<string, string>()

function isMarkdown(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/markdown')
}

// Viewer fetches and renders one file. Nothing is fetched until a file is
// selected: first a presigned URL from the API, then the content straight
// from S3. The parent keys this component by path, so selecting another
// file starts over with fresh state. Files seen before come from textCache.
//
// Only markdown renders so far; other types get an "Open file" button.
export function Viewer({ item }: { item: ManifestItem }) {
  const [state, setState] = useState<State>(() => {
    const text = textCache.get(item.sha256)
    return text === undefined ? { status: 'loading' } : { status: 'ready', text }
  })

  useEffect(() => {
    if (!isMarkdown(item) || textCache.has(item.sha256)) return
    const controller = new AbortController()
    const { signal } = controller

    getFileUrl(item.path, signal)
      .then(({ url }) => fetch(url, { signal }))
      .then((res) => {
        if (!res.ok) throw new Error(`Couldn't load the file (HTTP ${res.status})`)
        return res.text()
      })
      .then((text) => {
        textCache.set(item.sha256, text)
        setState({ status: 'ready', text })
      })
      .catch((err: unknown) => {
        if (signal.aborted) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [item])

  if (!isMarkdown(item)) return <OpenFile item={item} />
  if (state.status === 'loading') return <p className="placeholder">Loading…</p>
  if (state.status === 'error') return <p className="viewer-error">{state.message}</p>

  return (
    <Suspense fallback={<p className="placeholder">Loading…</p>}>
      <MarkdownView text={state.text} />
    </Suspense>
  )
}

// OpenFile stands in for a preview: the browser shows PDFs and images well
// in a tab of its own. Presigned URLs only last a few minutes, so a fresh one
// is fetched on each tap rather than when the file opens. The tab is opened
// before the fetch, while still inside the tap, or Safari blocks it as a
// popup; it is then pointed at the URL once that arrives.
function OpenFile({ item }: { item: ManifestItem }) {
  const [error, setError] = useState<string | null>(null)

  function open() {
    setError(null)
    const tab = window.open('', '_blank')
    getFileUrl(item.path)
      .then(({ url }) => {
        if (tab) tab.location.href = url
        else window.location.href = url
      })
      .catch((err: unknown) => {
        tab?.close()
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <div className="open-file">
      <p className="placeholder">No preview for this file type yet.</p>
      <button type="button" className="open-file-button" onClick={open}>
        Open file ↗
      </button>
      {error && <p className="viewer-error">{error}</p>}
    </div>
  )
}
