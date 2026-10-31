import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getManifest, type ManifestItem } from './api'
import { TreeView } from './TreeView'
import { buildTree } from './tree'
import { Viewer } from './Viewer'
import './App.css'

// The open file's path lives in the URL hash so a reload reopens it.
// Slashes stay readable; everything else is percent-encoded.
function pathFromHash(): string | null {
  const raw = window.location.hash.slice(1)
  return raw ? decodeURIComponent(raw) : null
}

function hashFromPath(path: string): string {
  return '#' + encodeURIComponent(path).replace(/%2F/g, '/')
}

// ancestorFolders('a/b/c.md') is ['a', 'a/b'].
function ancestorFolders(path: string): string[] {
  const segments = path.split('/').slice(0, -1)
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'))
}

// App shell: header plus tree and viewer panes.
export default function App() {
  const [items, setItems] = useState<ManifestItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Lives here rather than in TreeView so that opening a file from a deep link
  // can later expand the folders on its path.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const tree = useMemo(() => (items ? buildTree(items) : null), [items])
  const byPath = useMemo(() => new Map(items?.map((item) => [item.path, item])), [items])
  const selectedItem = selected ? byPath.get(selected) : undefined

  // Scroll position when switching files. Two-pane, the viewer pane is its
  // own scroller and stays mounted, so a new file would otherwise open
  // scrolled to wherever the last one was left. Single-pane, the whole page
  // scrolls: a file opens at the top, and going back to the tree returns to
  // where the tree was. (Whichever doesn't apply is a no-op.) Layout effect,
  // so the jump happens before the frame is painted.
  const viewerRef = useRef<HTMLElement>(null)
  const treeScrollY = useRef(0)
  const selectFile = (path: string) => {
    if (selected === null) treeScrollY.current = window.scrollY
    setSelected(path)
  }
  useLayoutEffect(() => {
    viewerRef.current?.scrollTo(0, 0)
    window.scrollTo(0, selected === null ? treeScrollY.current : 0)
  }, [selected])

  // Mirror the selection into the hash. replaceState, so this adds no
  // Back/Forward entries (full hash routing is still to come).
  useEffect(() => {
    const url = selected
      ? hashFromPath(selected)
      : window.location.pathname + window.location.search
    window.history.replaceState(null, '', url)
  }, [selected])

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  // Read before the effect above clears the hash on first render.
  const initialPath = useRef(pathFromHash())

  useEffect(() => {
    const controller = new AbortController()
    getManifest(controller.signal)
      .then((manifest) => {
        setItems(manifest)
        // Reopen the file from the hash if it still exists (it may have been
        // renamed or deleted since), with the folders above it expanded.
        const path = initialPath.current
        if (path && manifest.some((item) => item.path === path)) {
          setExpanded(new Set(ancestorFolders(path)))
          setSelected(path)
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [])

  return (
    <div className="shell" data-selected={selected !== null}>
      <header className="header">
        <button className="back" onClick={() => setSelected(null)}>
          ‹ Files
        </button>
        <h1>Docs</h1>
        {items && <span className="count">{items.length} files</span>}
      </header>

      <div className="panes">
        <nav className="pane tree-pane">
          {error && <p>Error: {error}</p>}
          {!error && !tree && <p className="placeholder">Loading…</p>}
          {tree && (
            <TreeView
              root={tree}
              expanded={expanded}
              selected={selected}
              onToggle={toggleFolder}
              onSelect={selectFile}
            />
          )}
        </nav>

        <main className="pane viewer-pane" ref={viewerRef}>
          {selectedItem ? (
            <Viewer key={selectedItem.path} item={selectedItem} />
          ) : (
            <p className="placeholder">Select a file.</p>
          )}
        </main>
      </div>
    </div>
  )
}
