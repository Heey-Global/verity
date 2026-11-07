import { describe, expect, it } from 'vitest';

import { markdownLinks, resolveKnowledgeLink } from './knowledge-wiki.js';

describe('resolveKnowledgeLink', () => {
  it('opens Wiki pages, decisions and sources relative to the page', () => {
    expect(resolveKnowledgeLink('insights/page.md', 'other.md')).toBe('insights/other.md');
    expect(resolveKnowledgeLink('insights/page.md', './decisions/abc.md')).toBe(
      'insights/decisions/abc.md',
    );
    expect(resolveKnowledgeLink('insights/topic/page.md', '../index.md')).toBe('insights/index.md');
    expect(resolveKnowledgeLink('insights/page.md', '../sources/meetings/m.md')).toBe(
      'sources/meetings/m.md',
    );
    // A decision links its predecessor by bare file name, beside itself.
    expect(resolveKnowledgeLink('insights/decisions/b.md', 'a.md')).toBe('insights/decisions/a.md');
  });

  it('opens the absolute paths agents write the same as relative ones', () => {
    expect(resolveKnowledgeLink('insights/page.md', '/knowledge/insights/decisions/x.md')).toBe(
      'insights/decisions/x.md',
    );
    expect(resolveKnowledgeLink('insights/page.md', '/knowledge/sources/documents/a.pdf')).toBe(
      'sources/documents/a.pdf',
    );
  });

  it('keeps anchors and queries off the file and decodes spaces', () => {
    expect(resolveKnowledgeLink('insights/page.md', 'other.md#rollout')).toBe('insights/other.md');
    expect(resolveKnowledgeLink('insights/page.md', 'my%20page.md')).toBe('insights/my page.md');
    expect(resolveKnowledgeLink('insights/page.md', '<my page.md>')).toBe('insights/my page.md');
  });

  // Each of these would open something outside the project's knowledge, or
  // nothing at all, if it resolved.
  it('leaves the project knowledge alone', () => {
    for (const href of [
      'https://example.com/a.md',
      'mailto:someone@example.com',
      'javascript:alert(1)',
      '//example.com/a.md',
      '#section',
      '../../etc/passwd',
      '../../../x.md',
      '/etc/passwd',
      '/knowledge/shared/insights/x.md',
      '/knowledge/.text/x.md',
      '../.text/insights/x.md',
      '..\\sources\\x.md',
      '%E0%A4%A.md',
    ])
      expect(resolveKnowledgeLink('insights/page.md', href)).toBeNull();
    // The Sources root itself, or the Wiki's, is a folder and not a file.
    expect(resolveKnowledgeLink('insights/page.md', '../sources')).toBeNull();
  });
});

describe('markdownLinks', () => {
  it('finds links in prose, lists and tables, but not images or code', () => {
    const page = [
      '# Title',
      'See [the plan](plan.md) and [docs](https://example.com).',
      '- [Decision](decisions/a.md "title")',
      '| [cell](cell.md) |',
      '![diagram](diagram.png)',
      'Inline `[not](code.md)` here.',
      '```',
      '[fenced](fenced.md)',
      '```',
    ].join('\n');
    expect(markdownLinks(page).map((link) => link.href)).toEqual([
      'plan.md',
      'https://example.com',
      'decisions/a.md',
      'cell.md',
    ]);
  });
});
