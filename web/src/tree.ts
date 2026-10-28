// Turns the flat manifest (one entry per file path) into the nested
// folder/file tree the navigation UI drills down through.

import type { ManifestItem } from './api'

export interface FileNode {
  kind: 'file'
  name: string
  path: string
  item: ManifestItem
}

export interface FolderNode {
  kind: 'folder'
  name: string
  // Folder path without a trailing slash; '' for the root.
  path: string
  children: TreeNode[]
}

export type TreeNode = FileNode | FolderNode

// Natural, case-insensitive order: "2-notes" before "10-notes", and
// "apple" next to "Apple". Ties fall back to a plain comparison so the
// order is always deterministic.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

// buildTree folds every path into a tree under a single root folder.
// Within each folder, subfolders come before files, then names sort
// naturally.
export function buildTree(items: ManifestItem[]): FolderNode {
  const root: FolderNode = { kind: 'folder', name: '', path: '', children: [] }
  const folders = new Map<string, FolderNode>([['', root]])

  for (const item of items) {
    const segments = item.path.split('/')
    const fileName = segments.pop()!
    let parent = root

    for (const segment of segments) {
      const path = parent.path ? `${parent.path}/${segment}` : segment
      let folder = folders.get(path)
      if (!folder) {
        folder = { kind: 'folder', name: segment, path, children: [] }
        folders.set(path, folder)
        parent.children.push(folder)
      }
      parent = folder
    }

    parent.children.push({ kind: 'file', name: fileName, path: item.path, item })
  }

  for (const folder of folders.values()) {
    folder.children.sort(compareNodes)
  }
  return root
}
