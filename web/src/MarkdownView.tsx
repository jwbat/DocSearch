import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

import './highlight.css'

// Inline HTML in markdown (<br>, <sup>, <details>, …) renders the way it does
// on GitHub: rehype-raw parses it, and rehype-sanitize then strips anything
// unsafe (scripts, event handlers, iframes) using GitHub's own allowlist.
//
// Fenced code blocks with a language tag (```python, ```bash, ```go, …) are
// then syntax-highlighted by rehype-highlight; untagged blocks stay plain.
//
// Order matters: sanitize runs after raw, and highlight runs last so the
// sanitizer doesn't strip its class names.
const rehypePlugins = [rehypeRaw, rehypeSanitize, rehypeHighlight]

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
