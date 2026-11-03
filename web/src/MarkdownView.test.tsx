import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import MarkdownView from './MarkdownView'

function render(text: string): string {
  return renderToStaticMarkup(<MarkdownView text={text} />)
}

describe('MarkdownView sanitizing', () => {
  it('keeps a style attribute on span and div', () => {
    const html = render('<span style="color: #ff1522">red</span>\n\n<div style="padding: 1em">box</div>')
    expect(html).toContain('<span style="color:#ff1522">red</span>')
    expect(html).toContain('<div style="padding:1em">box</div>')
  })

  it('still strips scripts and event handlers', () => {
    const html = render('<span style="color: red" onclick="alert(1)">x</span>\n\n<script>alert(1)</script>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
  })

  it('does not allow style on other elements', () => {
    expect(render('<p style="color: red">x</p>')).not.toContain('style=')
  })

  it('renders block tags as divs and inline tags as spans, with markdown inside', () => {
    const html = render('<warn>\n\n**Careful**\n\n</warn>\n\nA <mark>key</mark> and <muted>quiet</muted> word.')
    expect(html).toMatch(/<div class="warn">\s*<p><strong>Careful<\/strong><\/p>\s*<\/div>/)
    expect(html).toContain('<span class="mark">key</span>')
    expect(html).toContain('<span class="muted">quiet</span>')
  })

  it('renders aside, a real HTML block tag, the same way', () => {
    expect(render('<aside>\n\nside\n\n</aside>')).toMatch(/<div class="aside">\s*<p>side<\/p>\s*<\/div>/)
  })

  it('no longer accepts class names written in the doc', () => {
    const html = render('<div class="warn">x</div>\n\n<span class="mark">y</span>')
    expect(html).not.toContain('class="warn"')
    expect(html).not.toContain('class="mark"')
  })
})
