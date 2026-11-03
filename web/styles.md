# Special tags for Docs markdown

Tags a markdown file in Docs can use to style its own content. This is the
list to check (and update) when adding or changing one.

## Available tags

| Tag          | Scope  | Renders as                | Look                                                              |
|--------------|--------|---------------------------|-------------------------------------------------------------------|
| `<note>`     | block  | `<div class="note">`      | Amber left border and tint (the app's accent color), with padding |
| `<tip>`      | block  | `<div class="tip">`       | Same shape, muted green                                           |
| `<warn>`     | block  | `<div class="warn">`      | Same shape, coral (the color the viewer already uses for errors)  |
| `<aside>`    | block  | `<div class="aside">`     | No box: smaller, dimmer, indented text for side remarks           |
| `<indent>`   | block  | `<div class="indent">`    | Indented 2 characters, on every line; nested indents add up       |
| `<nowrap>`   | block  | `<div class="nowrap">`    | Each source line stays one line; long ones scroll sideways        |
| `<mark>`     | inline | `<span class="mark">`     | Accent-colored highlight                                          |
| `<muted>`    | inline | `<span class="muted">`    | Dimmed text                                                       |
| `<bright>`   | inline | `<span class="bright">`   | Bright yellow-green text (`#ddf093`)                              |
| `<bold>`     | inline | `<span class="bold">`     | Bold (weight 700), the same as markdown's `**bold**`              |
| `<semibold>` | inline | `<span class="semibold">` | Semibold (weight 600), the headings' weight: a step lighter       |

Block:

```markdown
Some paragraph.

<note>

**Heads up:** the sync runs nightly.

</note>
```

Inline:

```markdown
A <mark>key term</mark> and a <muted>quiet aside</muted>.
```

## Usage notes

- **Block tags need blank lines around them, and inside them** (except
  `<nowrap>`, below): before `<note>`, after it, and before `</note>`, as
  in the example above.
  - With no blank line *before* the tag, it gets pulled into the paragraph
    above it and renders as an empty box, with the content outside it.
  - With no blank lines *inside*, markdown inside isn't parsed and
    `**bold**` prints literally.
  - Short one-liners are the exception: `<tip>**Tip:** use ← →</tip>` on
    its own line works and renders markdown.
- **`<nowrap>` keeps your lines as typed** instead of reflowing them:
  each line in the source is one line on screen, and runs of spaces
  mid-line are kept. Unlike the other block tags, it works with or without
  blank lines, e.g. right under a name line:

  ```markdown
  <bright>des Prez, Josquin</bright>
  <indent>
  <nowrap>
  Born: c. 1450
  Died: 27th August 1521, Condé-sur-l'Escaut, France
  </nowrap>
  </indent>
  ```

  - **Markdown inside needs the blank-line form** (blank lines inside
    `<nowrap>`) when the block stands on its own, i.e. after a blank line
    or at the top of the file. Written compactly there, markdown treats the
    whole block as raw HTML, so `**bold**` prints literally. Right after a
    line of text, as above, markdown works either way.
  - **Leading indentation is lost:** markdown strips spaces at the start
    of a line (and 4+ spaces at the start of a paragraph make it a code
    block). Wrap it in `<indent>` to indent the whole block.
  - Ending lines with two spaces or `<br>` is harmless but not needed:
    each line already breaks. Trailing spaces are dropped.
  - The body font is proportional, so columns won't line up exactly. For
    exact alignment (tables of figures, ASCII diagrams), use a fenced code
    block (```` ``` ````) instead: monospace, everything kept exactly, but
    no markdown inside.
- **Tags combine by nesting:** `<indent>` around a paragraph containing
  `<mark>…</mark>` gives indented text with a highlighted phrase. Close
  each tag with its own `</name>`, innermost first.
- **`<bold>` vs `**bold**`:** they look the same, but `<bold>` is a tag,
  so it still works where markdown isn't parsed, e.g. in a compact
  `<nowrap>` block on its own. Weights combine with colors by nesting:
  `<bright><semibold>des Prez</semibold></bright>`.
- **Inline tags go mid-sentence,** like `<span>`. Markdown inside them
  (`**bold**`, `` `code` ``) works.
- **Always close the tag.** `<note/>` isn't self-closing in HTML: it's
  treated as an opening tag and styles everything after it.
- **Tag names aren't case-sensitive:** `<NOTE>` is the same as `<note>`.
- **Only the tags listed here are special.** Classes written in a doc
  (`<div class="note">`) are dropped, so a doc can't pick up the app's own
  classes like `header`.
- **Fitting the layout:** block tags use the same left-rule style as
  blockquotes and the same 1em bottom margin as paragraphs. The last
  paragraph inside one drops its bottom margin, so the padding is even on
  all sides. They stay inside the 70ch text column and wrap normally on the
  phone.
- **On GitHub these show as plain text,** with the tags removed, so docs
  still read fine there. (`<aside>` and `<mark>` are real HTML tags, but
  GitHub strips them too.)
- An unknown tag (`<something>…</something>`) doesn't cause an error: the
  tag is dropped and the text inside it still shows.
- A `style` attribute on `<span>` and `<div>` is allowed for one-off
  styling, e.g. `<span style="color: #ff1522">red</span>`.

## Where the code is

| What                                 | File                        |
|--------------------------------------|-----------------------------|
| Tag lists, sanitizer, rename plugin  | `src/MarkdownView.tsx`      |
| The styles                           | `src/Viewer.css`            |
| Color variables                      | `src/index.css`             |
| Tests                                | `src/MarkdownView.test.tsx` |

The sanitizer lets the tags through, then a small plugin (`rehypeSpecialTags`)
renames each to a `<div>` or `<span>` with the tag's name as its class, so the
rendered page has only standard elements.

To add a tag: add its name to `BLOCK_TAGS` or `INLINE_TAGS` in
`MarkdownView.tsx`, style it as `.markdown .<name>` in `Viewer.css` (colors
as variables in `index.css`), and add a row to this file. Avoid names of
real HTML tags with their own behavior (`<b>`, `<small>`, `<details>`, …),
since the rename would replace it.
