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

  describe('<nowrap>', () => {
    // white-space: pre shows every newline left in the block, so each source
    // line must come out as exactly one newline, and nothing extra.
    const lines = "Born: c. 1450\nDied: 27th August 1521, Condé-sur-l&#x27;Escaut, France"

    it('keeps source line breaks and spaces, with blank lines around and inside', () => {
      const html = render('<nowrap>\n\nline one  **bold**\nline two\n\n</nowrap>')
      expect(html).toContain('<div class="nowrap"><p>line one  <strong>bold</strong>\nline two</p></div>')
    })

    it('works written compactly, with no blank lines', () => {
      const html = render("<indent>\n<nowrap>\nBorn: c. 1450\nDied: 27th August 1521, Condé-sur-l'Escaut, France\n</nowrap>\n</indent>")
      expect(html).toContain(`<div class="nowrap">${lines}</div>`)
    })

    it('drops trailing spaces, which markdown leaves as-is in a compact block', () => {
      const html = render("<nowrap>\nBorn: c. 1450    \nDied: 27th August 1521, Condé-sur-l'Escaut, France    \n</nowrap>")
      expect(html).toContain(`<div class="nowrap">${lines}</div>`)
    })

    it('works right after a line of text, as in a list of entries', () => {
      const html = render("<lime>des Prez, Josquin</lime>    \n<indent>\n<nowrap>\nBorn: c. 1450    \nDied: 27th August 1521, Condé-sur-l'Escaut, France    \n</nowrap>\n</indent>")
      expect(html).toContain(`<div class="nowrap">${lines.replace('\n', '<br/>')}<br/></div>`)
    })

    it('leaves code blocks inside it alone', () => {
      expect(render('<nowrap>\n\n```\na\n\nb\n```\n\n</nowrap>')).toContain('<pre><code>a\n\nb\n</code></pre>')
    })
  })

  describe('an inline tag on a line of its own', () => {
    const poem =
      '<magenta>  \nThere is the leisurely one,  \nWalking the Tao.  \n\n<br>    \n\nWhen the Dharma body awakens completely,  \nThere is nothing at all.  \n</magenta>\n'

    it('wraps whole paragraphs, keeping their line breaks', () => {
      const html = render(poem)
      expect(html).toMatch(/^<article class="markdown"><span class="magenta">/)
      expect(html).toContain('<p>There is the leisurely one,<br/>\nWalking the Tao.</p>')
      expect(html).toContain('<p>When the Dharma body awakens completely,<br/>\nThere is nothing at all.</p>')
      expect(html).toMatch(/<\/span><\/article>$/)
    })

    it('keeps a <br> between stanzas as its own break, between the paragraphs', () => {
      expect(render(poem)).toMatch(/<\/p>\s*<br\/>\s*<p>/)
    })

    it('works without the closing tag, and right after a line of text', () => {
      const html = render('Intro line\n<gold>\nstanza **one**\n')
      expect(html).toContain('<p>Intro line</p>')
      expect(html).toMatch(/<span class="gold">\s*<p>stanza <strong>one<\/strong><\/p>/)
    })

    it('leaves fenced code alone', () => {
      expect(render('```\n<gold>\nx\n```')).toContain('<code>&lt;gold&gt;\nx\n</code>')
    })
  })

  it('no longer accepts class names written in the doc', () => {
    const html = render('<div class="warn">x</div>\n\n<span class="mark">y</span>')
    expect(html).not.toContain('class="warn"')
    expect(html).not.toContain('class="mark"')
  })
})
