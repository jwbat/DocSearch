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
})
