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
// Text files are small, so nothing is ever evicted.
const textCache = new Map<string, string>()

function isMarkdown(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/markdown')
}

function isPlainText(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/plain')
}

// isText reports whether the file is fetched and shown inline.
function isText(item: ManifestItem): boolean {
  return isMarkdown(item) || isPlainText(item)
}

// Viewer fetches and renders one file. Nothing is fetched until a file is
// selected: first a presigned URL from the API, then the content straight
// from S3. The parent keys this component by path, so selecting another
// file starts over with fresh state. Files seen before come from textCache.
//
// Markdown and plain text render inline; other types get an "Open file"
// button.
export function Viewer({ item }: { item: ManifestItem }) {
  const [state, setState] = useState<State>(() => {
    const text = textCache.get(item.sha256)
    return text === undefined ? { status: 'loading' } : { status: 'ready', text }
  })

  useEffect(() => {
    if (!isText(item) || textCache.has(item.sha256)) return
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

  if (!isText(item)) return <OpenFile item={item} />
  if (state.status === 'loading') return <p className="placeholder">Loading…</p>
  if (state.status === 'error') return <p className="viewer-error">{state.message}</p>

  // Plain text needs no renderer, so it skips the markdown chunk.
  if (isPlainText(item)) return <PlainTextView text={state.text} />

  return (
    <Suspense fallback={<p className="placeholder">Loading…</p>}>
      <MarkdownView text={state.text} />
    </Suspense>
  )
}

// The wrap choice for plain text is a reader preference, not per file, so it
// is kept in localStorage: it holds across files, reloads, and visits.
const WRAP_KEY = 'docsearch.wrapText'

function loadWrap(): boolean {
  return localStorage.getItem(WRAP_KEY) !== 'false'
}

// PlainTextView shows a text file as-is, with a toggle for line wrapping.
// Wrapping (the default) keeps everything in view, but on a phone a wrapped
// line looks like a line break of the file's own; unwrapped, each line stays
// one line and the block scrolls sideways instead.
function PlainTextView({ text }: { text: string }) {
  const [wrap, setWrap] = useState(loadWrap)

  function toggle() {
    const next = !wrap
    setWrap(next)
    localStorage.setItem(WRAP_KEY, String(next))
  }

  return (
    <div className="plain-text">
      <div className="plain-text-toolbar">
        <button
          type="button"
          className="wrap-toggle"
          aria-pressed={wrap}
          aria-label="Wrap lines"
          title="Wrap lines"
          onClick={toggle}
        >
          ↴
        </button>
      </div>
      <pre className={wrap ? 'wrap' : undefined}>{text}</pre>
    </div>
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
