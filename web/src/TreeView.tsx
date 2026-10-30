import type { CSSProperties } from 'react'

import type { FolderNode, TreeNode } from './tree'
import './TreeView.css'

interface TreeProps {
  root: FolderNode
  // Paths of the folders that are currently open.
  expanded: ReadonlySet<string>
  selected: string | null
  onToggle: (folderPath: string) => void
  onSelect: (filePath: string) => void
}

// TreeView is the disclosure-widget navigation: folders open and close in
// place, and files select. Only open folders render their children, so a
// large manifest costs nothing until it's drilled into.
//
// It uses plain nested lists of buttons (the disclosure pattern) rather than
// ARIA role="tree", which promises arrow-key navigation this doesn't have.
export function TreeView(props: TreeProps) {
  return (
    <ul className="tree">
      {props.root.children.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} {...props} />
      ))}
    </ul>
  )
}

function TreeItem({ node, depth, ...props }: TreeProps & { node: TreeNode; depth: number }) {
  // Indentation is driven from CSS via --depth.
  const style = { '--depth': depth } as CSSProperties

  if (node.kind === 'folder') {
    const open = props.expanded.has(node.path)
    return (
      <li>
        <button
          className="tree-row folder"
          style={style}
          aria-expanded={open}
          onClick={() => props.onToggle(node.path)}
        >
          <span className="chevron" aria-hidden="true">▸</span>
          <span className="name">{node.name}</span>
        </button>
        {open && (
          <ul>
            {node.children.map((child) => (
              <TreeItem key={child.path} node={child} depth={depth + 1} {...props} />
            ))}
          </ul>
        )}
      </li>
    )
  }

  const selected = props.selected === node.path
  return (
    <li>
      <button
        className="tree-row file"
        style={style}
        aria-current={selected ? 'page' : undefined}
        onClick={() => props.onSelect(node.path)}
      >
        <span className="chevron" aria-hidden="true" />
        <span className="name">{node.name}</span>
      </button>
    </li>
  )
}
