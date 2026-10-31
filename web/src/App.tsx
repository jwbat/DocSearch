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

interface Visited {
  paths: string[]
  index: number
}

// The visited list survives a reload of a file, via sessionStorage, but a
// reload of the tree (no file in the hash) starts it over.
const VISITED_KEY = 'docsearch.visited'

function loadVisited(): Visited {
  const empty = { paths: [], index: -1 }
  if (pathFromHash() === null) {
    sessionStorage.removeItem(VISITED_KEY)
    return empty
  }
  try {
    const stored = JSON.parse(sessionStorage.getItem(VISITED_KEY) ?? 'null')
    return Array.isArray(stored?.paths) && typeof stored?.index === 'number' ? stored : empty
  } catch {
    return empty
  }
}

// App shell: header plus tree and viewer panes.
export default function App() {
  const [items, setItems] = useState<ManifestItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Lives here rather than in TreeView so that opening a file from a deep link
  // can later expand the folders on its path.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // Files opened so far, for the header's ← → buttons. Each file appears
  // once: picking it in the tree again moves it to the end. Only files go in
  // it, so the arrows never lead back to the tree.
  const [visited, setVisited] = useState<Visited>(loadVisited)
  useEffect(() => {
    sessionStorage.setItem(VISITED_KEY, JSON.stringify(visited))
  }, [visited])

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
  const openFile = (path: string) => {
    if (selected === null) treeScrollY.current = window.scrollY
    setSelected(path)
  }

  // A file picked in the tree goes to the end of the visited list.
  const selectFile = (path: string) => {
    openFile(path)
    setVisited(({ paths }) => {
      const next = [...paths.filter((p) => p !== path), path]
      return { paths: next, index: next.length - 1 }
    })
  }

  // ← and → step through the visited list. The folders above the file open
  // too, so two-pane the tree shows where it is.
  const step = (delta: -1 | 1) => {
    const index = visited.index + delta
    const path = visited.paths[index]
    if (path === undefined) return
    setVisited({ paths: visited.paths, index })
    setExpanded((prev) => new Set([...prev, ...ancestorFolders(path)]))
    openFile(path)
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
        // Visited files that are gone drop out of the list; the reopened one
        // keeps its place, or joins the end if it's new (a deep link).
        const live = new Set(manifest.map((item) => item.path))
        const path = initialPath.current
        const reopen = path !== null && live.has(path)
        if (reopen) {
          setExpanded(new Set(ancestorFolders(path)))
          setSelected(path)
        }
        setVisited(({ paths }) => {
          const kept = paths.filter((p) => live.has(p))
          if (!reopen) return { paths: kept, index: kept.length - 1 }
          const at = kept.indexOf(path)
          return at >= 0 ? { paths: kept, index: at } : { paths: [...kept, path], index: kept.length }
        })
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
        <div className="history">
          <button aria-label="Previous file" disabled={!items || visited.index <= 0} onClick={() => step(-1)}>
            ←
          </button>
          <button
            aria-label="Next file"
            disabled={!items || visited.index >= visited.paths.length - 1}
            onClick={() => step(1)}
          >
            →
          </button>
        </div>
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
