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
// file a new hash, so a refreshed manifest misses here and fetches it. Text
// files are small, so nothing is ever evicted.
const textCache = new Map<string, string>()

function isMarkdown(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/markdown')
}

function isPlainText(item: ManifestItem): boolean {
  return item.content_type.startsWith('text/plain')
}

// isText reports whether the file is fetched and shown inline as text.
function isText(item: ManifestItem): boolean {
  return isMarkdown(item) || isPlainText(item)
}

// Image types every browser can show. Others (HEIC, say) get "Open file".
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

function isImage(item: ManifestItem): boolean {
  return IMAGE_TYPES.some((type) => item.content_type.startsWith(type))
}

function isPdf(item: ManifestItem): boolean {
  return item.content_type.startsWith('application/pdf')
}

// Viewer fetches and renders one file. Nothing is fetched until a file is
// selected: first a presigned URL from the API, then the content straight
// from S3. The parent keys this component by path, so selecting another
// file starts over with fresh state. Files seen before come from textCache.
//
// Markdown, plain text, and images render inline; other types (PDF) get an
// "Open file" button.
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

  // A refreshed manifest can change the hash of the open file. The cache wins
  // over state, which still holds the old text; on a miss that text stays up
  // until the new text arrives.
  const cached = textCache.get(item.sha256)
  const shown: State = cached === undefined ? state : { status: 'ready', text: cached }

  if (isImage(item)) return <ImageView item={item} />
  if (!isText(item)) return <OpenFile item={item} />
  if (shown.status === 'loading') return <p className="placeholder">Loading…</p>
  if (shown.status === 'error') return <p className="viewer-error">{shown.message}</p>

  // Plain text needs no renderer, so it skips the markdown chunk.
  if (isPlainText(item)) return <PlainTextView text={shown.text} />

  return (
    <Suspense fallback={<p className="placeholder">Loading…</p>}>
      <MarkdownView text={shown.text} />
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

// Object URLs of images loaded so far, keyed by sha256 like textCache. A
// presigned URL can't be cached (it expires, and its signature differs each
// time, so the browser's HTTP cache never hits), so the image itself is kept
// as a blob. Images can run to megabytes, so only the most recent few are
// kept: Map order is insertion order, a hit moves the entry to the end, and
// the oldest is revoked. Only the open file's image is on screen, and it is
// always the newest entry, so eviction never pulls one out from under it.
const IMAGE_CACHE_SIZE = 20
const imageCache = new Map<string, string>()

function cachedImage(sha256: string): string | undefined {
  const url = imageCache.get(sha256)
  if (url !== undefined) {
    imageCache.delete(sha256)
    imageCache.set(sha256, url)
  }
  return url
}

function cacheImage(sha256: string, url: string) {
  imageCache.set(sha256, url)
  while (imageCache.size > IMAGE_CACHE_SIZE) {
    const [oldest, oldUrl] = imageCache.entries().next().value!
    imageCache.delete(oldest)
    URL.revokeObjectURL(oldUrl)
  }
}

type ImageState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

// ImageView shows an image scaled down to fit the pane's width; a tall one
// scrolls. OpenFullSize, up in the header, gives it a tab of its own, for
// zooming or saving.
function ImageView({ item }: { item: ManifestItem }) {
  const [state, setState] = useState<ImageState>(() => {
    const url = cachedImage(item.sha256)
    return url === undefined ? { status: 'loading' } : { status: 'ready', url }
  })

  useEffect(() => {
    if (cachedImage(item.sha256) !== undefined) return
    const controller = new AbortController()
    const { signal } = controller

    getFileUrl(item.path, signal)
      .then(({ url }) => fetch(url, { signal }))
      .then((res) => {
        if (!res.ok) throw new Error(`Couldn't load the image (HTTP ${res.status})`)
        return res.blob()
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        cacheImage(item.sha256, url)
        setState({ status: 'ready', url })
      })
      .catch((err: unknown) => {
        if (signal.aborted) return
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [item])

  // As in Viewer: the cache wins when a refresh changes the hash, except over
  // an error, which may be this very image failing to display.
  const cached = imageCache.get(item.sha256)
  const shown: ImageState =
    cached === undefined || state.status === 'error' ? state : { status: 'ready', url: cached }

  return (
    <div className="image-view">
      {shown.status === 'loading' && <p className="placeholder">Loading…</p>}
      {shown.status === 'error' && <p className="viewer-error">{shown.message}</p>}
      {shown.status === 'ready' && (
        <img
          src={shown.url}
          alt={item.path.split('/').pop()}
          onError={() => setState({ status: 'error', message: "Couldn't show this image." })}
        />
      )}
    </div>
  )
}

// OpenFile stands in for a preview of types shown best by the browser in a
// tab of its own: PDFs, in its PDF viewer (Decision 10 in outline.md).
function OpenFile({ item }: { item: ManifestItem }) {
  return (
    <div className="open-file">
      <p className="placeholder">
        {isPdf(item)
          ? "PDFs open in your browser's viewer."
          : 'No preview for this file type.'}
      </p>
      <OpenFileButton item={item} label="Open file ↗" />
    </div>
  )
}

// useOpenInTab opens the file in a new tab. Presigned URLs only last a few
// minutes, so a fresh one is fetched on each tap rather than when the file
// opens. The tab is opened before the fetch, while still inside the tap, or
// Safari blocks it as a popup; it is then pointed at the URL once that
// arrives.
function useOpenInTab(item: ManifestItem) {
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

  return { open, error }
}

function OpenFileButton({ item, label }: { item: ManifestItem; label: string }) {
  const { open, error } = useOpenInTab(item)

  return (
    <>
      <button type="button" className="open-file-button" onClick={open}>
        {label}
      </button>
      {error && <p className="viewer-error">{error}</p>}
    </>
  )
}

// OpenFullSize is the header's ↗ button, shown only for an image, so the
// button takes no room from the image itself. The parent keys it by path, so
// an error doesn't outlive its file.
export function OpenFullSize({ item }: { item: ManifestItem }) {
  const { open, error } = useOpenInTab(item)

  if (!isImage(item)) return null

  return (
    <>
      <button type="button" aria-label="Open full size" title="Open full size" onClick={open}>
        ↗
      </button>
      {error && <p className="viewer-error open-full-size-error">{error}</p>}
    </>
  )
}
