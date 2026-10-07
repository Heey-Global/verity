import { describe, expect, it } from 'vitest';
import { isMarkdownPath, markdownToHtml, printableFileHtml } from './printDocument.js';

describe('markdownToHtml', () => {
  it('formats headings, paragraphs, emphasis and rules', () => {
    const html = markdownToHtml(
      '# Title\n\nFirst line\nsecond line with **bold** and *em*.\n\n---\n\n## Next',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain(
      '<p>First line second line with <strong>bold</strong> and <em>em</em>.</p>',
    );
    expect(html).toContain('<hr>');
    expect(html).toContain('<h2>Next</h2>');
  });

  it('strips only a whitespace-separated closing hash run from headings', () => {
    expect(markdownToHtml('# Using C#')).toBe('<h1>Using C#</h1>');
    expect(markdownToHtml('## Closed ##')).toBe('<h2>Closed</h2>');
  });

  it('leaves snake_case identifiers alone', () => {
    expect(markdownToHtml('call max_old_space_size now')).toBe(
      '<p>call max_old_space_size now</p>',
    );
  });

  it('nests lists by indentation and closes every item', () => {
    const html = markdownToHtml('- a\n  - a1\n  - a2\n- b\n\n1. one\n2. two');
    expect(html.replace(/\n/g, '')).toBe(
      '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>' +
        '<ol><li>one</li><li>two</li></ol>',
    );
  });

  it('renders task list checkboxes, quotes, tables and fenced code', () => {
    const html = markdownToHtml(
      '- [x] done\n- [ ] open\n\n> quoted\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1 < 2;\n```',
    );
    expect(html).toContain('&#9745; done');
    expect(html).toContain('&#9744; open');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<th>A</th><th>B</th>');
    expect(html).toContain('<td>1</td><td>2</td>');
    expect(html).toContain('<pre><code>const a = 1 &lt; 2;</code></pre>');
  });

  it('prints YAML front matter as metadata instead of a rule', () => {
    const html = markdownToHtml('---\ntitle: x\n---\n# Body');
    expect(html).toContain('<pre class="front-matter">title: x</pre>');
    expect(html).not.toContain('<hr>');
  });

  // The HTML is rendered by a native web view: markup or script targets from a
  // worktree file must never become live elements.
  it('escapes raw HTML and only links http(s) targets', () => {
    const html = markdownToHtml(
      '<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.example/?q="1")',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<a href="https://a.example/?q=&quot;1&quot;">ok</a>');
  });
});

describe('printableFileHtml', () => {
  it('formats markdown files and prints other text verbatim', () => {
    expect(printableFileHtml('notes/a.md', '# Hi')).toContain('<h1>Hi</h1>');
    const code = printableFileHtml('src/a.ts', '# not a heading <b>');
    expect(code).toContain('<pre class="plain"># not a heading &lt;b&gt;</pre>');
    expect(code).toContain('<title>a.ts</title>');
  });

  it('recognizes markdown paths', () => {
    expect(isMarkdownPath('x/2026-09-30-reflection.md')).toBe(true);
    expect(isMarkdownPath('README')).toBe(true);
    expect(isMarkdownPath('a.txt')).toBe(false);
  });
});
