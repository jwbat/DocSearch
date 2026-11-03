import type { Root, RootContent } from 'hast'
import Markdown, { type Options } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import './highlight.css'

// Inline HTML in markdown (<br>, <sup>, <details>, …) renders the way it does
// on GitHub: rehype-raw parses it, and rehype-sanitize then strips anything
// unsafe (scripts, event handlers, iframes) using GitHub's own allowlist.
//
// One addition to that allowlist: a style attribute on <span> and <div>, so
// a doc can color or otherwise style its own text, e.g.
// <span style="color: #ff1522">. CSS can't run script, and the docs are our
// own. GitHub and other viewers drop the style and show the text plain.
//
// Also a few special tags, each a named style defined in Viewer.css:
//   <note> <tip> <warn> <aside> <indent>   blocks, rendered as <div class="…">
//   <mark> <muted>                         inline, rendered as <span class="…">
// The sanitizer lets them through, then rehypeSpecialTags (after it) renames
// them. Docs can't set class themselves, so they can't borrow the app's own
// class names. Markdown inside a block tag is only parsed if a blank line
// follows the tag. web/styles.md is the reference for these; keep it in step.
//
// Fenced code blocks with a language tag (```python, ```bash, ```go, …) are
// then syntax-highlighted by rehype-highlight; untagged blocks stay plain.
//
// Order matters: sanitize runs after raw; the special tags are renamed after
// sanitizing, and highlight runs last, so the sanitizer doesn't strip the
// class names either of them adds.
const BLOCK_TAGS = ['note', 'tip', 'warn', 'aside', 'indent']
const INLINE_TAGS = ['mark', 'muted', 'bright']

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...BLOCK_TAGS, ...INLINE_TAGS],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), 'style'],
    div: [...(defaultSchema.attributes?.div ?? []), 'style'],
  },
}

// rehypeSpecialTags turns <note>…</note> into <div class="note">…</div>, and
// <mark>…</mark> into <span class="mark">…</span>, and so on.
function rehypeSpecialTags() {
  const rename = (node: Root | RootContent) => {
    if (node.type === 'element') {
      const name = node.tagName
      const block = BLOCK_TAGS.includes(name)
      if (block || INLINE_TAGS.includes(name)) {
        node.tagName = block ? 'div' : 'span'
        node.properties = { ...node.properties, className: [name] }
      }
    }
    if ('children' in node) node.children.forEach(rename)
  }
  return rename
}

const rehypePlugins: Options['rehypePlugins'] = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
  rehypeSpecialTags,
  rehypeHighlight,
]

// MarkdownView renders markdown text. It is most of the app's code by weight
// (the parser, sanitizer, and highlight.js grammars), so Viewer loads it
// lazily: it is downloaded the first time a markdown file opens, not with the
// page. Its default export is what React.lazy expects.
export default function MarkdownView({ text }: { text: string }) {
  return (
    <article className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}>
        {text}
      </Markdown>
    </article>
  )
}
