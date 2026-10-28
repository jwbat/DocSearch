import { describe, expect, it } from 'vitest'

import type { ManifestItem } from './api'
import { buildTree, type FolderNode, type TreeNode } from './tree'

function item(path: string): ManifestItem {
  return { path, sha256: `hash-${path}`, size_bytes: 1, content_type: 'text/plain', modified_time: '' }
}

// names flattens one folder level into its child names, for compact asserts.
function names(folder: FolderNode): string[] {
  return folder.children.map((c) => c.name)
}

function child(folder: FolderNode, name: string): TreeNode {
  const found = folder.children.find((c) => c.name === name)
  if (!found) throw new Error(`no child ${name} in ${folder.path || '(root)'}`)
  return found
}

function folderAt(folder: FolderNode, name: string): FolderNode {
  const node = child(folder, name)
  if (node.kind !== 'folder') throw new Error(`${name} is a file`)
  return node
}

describe('buildTree', () => {
  it('returns an empty root for an empty manifest', () => {
    const root = buildTree([])
    expect(root).toEqual({ kind: 'folder', name: '', path: '', children: [] })
  })

  it('nests files under their folders with full paths', () => {
    const root = buildTree([item('Book/Ethics/notes.md'), item('Book/intro.md'), item('top.txt')])

    expect(names(root)).toEqual(['Book', 'top.txt'])

    const book = folderAt(root, 'Book')
    expect(book.path).toBe('Book')
    expect(names(book)).toEqual(['Ethics', 'intro.md'])

    const ethics = folderAt(book, 'Ethics')
    expect(ethics.path).toBe('Book/Ethics')

    const notes = child(ethics, 'notes.md')
    expect(notes).toMatchObject({ kind: 'file', path: 'Book/Ethics/notes.md' })
    expect(notes.kind === 'file' && notes.item.sha256).toBe('hash-Book/Ethics/notes.md')
  })

  it('creates each folder once no matter how many files share it', () => {
    const root = buildTree([item('a/x.md'), item('a/y.md'), item('a/b/z.md'), item('a/b/w.md')])
    expect(names(root)).toEqual(['a'])
    const a = folderAt(root, 'a')
    expect(names(a)).toEqual(['b', 'x.md', 'y.md'])
    expect(names(folderAt(a, 'b'))).toEqual(['w.md', 'z.md'])
  })

  it('puts folders before files, then sorts naturally and case-insensitively', () => {
    const root = buildTree([
      item('zeta.md'),
      item('Alpha.md'),
      item('beta.md'),
      item('10-ten/x.md'),
      item('2-two/x.md'),
      item('Zoo/x.md'),
      item('apple/x.md'),
      item('file-10.md'),
      item('file-2.md'),
    ])
    expect(names(root)).toEqual([
      '2-two',
      '10-ten',
      'apple',
      'Zoo',
      'Alpha.md',
      'beta.md',
      'file-2.md',
      'file-10.md',
      'zeta.md',
    ])
  })

  it('handles names that look like path tricks as plain names', () => {
    const root = buildTree([item('notes/v1..2.md'), item('notes/.hidden-looking.md')])
    expect(names(folderAt(root, 'notes'))).toEqual(['.hidden-looking.md', 'v1..2.md'])
  })

  it('orders case-only differences deterministically', () => {
    const a = buildTree([item('readme.md'), item('README.md')])
    const b = buildTree([item('README.md'), item('readme.md')])
    expect(names(a)).toEqual(names(b))
  })
})
