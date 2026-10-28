import { useEffect, useState } from 'react'

import { getManifest } from './api'
import { buildTree, type FolderNode } from './tree'

// Placeholder for Phase 4: proves the API client and tree builder work
// against the real API. Phase 5 replaces this with the tree + viewer UI.
export default function App() {
  const [tree, setTree] = useState<FolderNode | null>(null)
  const [count, setCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getManifest(controller.signal)
      .then((items) => {
        setCount(items.length)
        setTree(buildTree(items))
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [])

  if (error) return <p>Error: {error}</p>
  if (!tree) return <p>Loading…</p>

  return (
    <main>
      <h1>DocSearch</h1>
      <p>{count} files</p>
      <ul>
        {tree.children.map((node) => (
          <li key={node.path}>
            {node.name}
            {node.kind === 'folder' ? '/' : ''}
          </li>
        ))}
      </ul>
    </main>
  )
}
