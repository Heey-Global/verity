import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageHeadline, parseWikiIndex, projectWikiCatalog } from './knowledge-wiki.js';

let root: string;
const write = (path: string, content: string) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};
const decision = (id: string, title: string, createdAt: string, predecessor?: string) =>
  write(
    `insights/decisions/${id}.md`,
    `<!-- verity-decision:v1 ${JSON.stringify({
      version: 1,
      id,
      requestHash: 'a'.repeat(64),
      title,
      sessionId: 's',
      confirmationMessageSeq: 1,
      createdAt,
      ...(predecessor ? { predecessor } : {}),
    })} -->\n# ${title}\n\nBody.\n`,
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wiki-catalog-'));
  mkdirSync(join(root, 'insights'));
  mkdirSync(join(root, 'sources/meetings'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('pageHeadline', () => {
  it('takes the first title and the first paragraph of prose as plain text', () => {
    expect(
      pageHeadline(
        'insights/x.md',
        '<!-- meta -->\n# Build **storage**\n\n- a list\n\nMeasured with [the runner](r.md) and `overlayfs`.\nSecond line.\n\nLater.',
      ),
    ).toEqual({
      title: 'Build storage',
      summary: 'Measured with the runner and overlayfs. Second line.',
    });
  });

  it('names a page without a heading after its file', () => {
    expect(pageHeadline('insights/mobile-ota_reload.md', 'Just text.')).toEqual({
      title: 'Mobile ota reload',
      summary: 'Just text.',
    });
  });
});

describe('parseWikiIndex', () => {
  it('reads the overview and one topic per second-level heading', () => {
    const index = parseWikiIndex(
      [
        '# Verity Wiki',
        '',
        'Start with the [concept](concept.md).',
        '',
        '## Mobile app',
        'Design system and performance.',
        '',
        '- [Audit](mobile/audit.md)',
        '- [Audit again](mobile/audit.md)',
        '- [Outside](https://example.com)',
        '## Meetings',
        '- [Intake](intake.md)',
        '## Mobile app',
        '- [Release](release.md)',
      ].join('\n'),
    );
    expect(index.overview).toBe('Start with the [concept](concept.md).');
    expect(index.topics).toEqual([
      {
        title: 'Mobile app',
        description: 'Design system and performance.',
        pages: ['insights/mobile/audit.md', 'insights/release.md'],
      },
      { title: 'Meetings', description: '', pages: ['insights/intake.md'] },
    ]);
  });
});

it('reads no topics or overview from code blocks and comments on the start page', () => {
  const index = parseWikiIndex(
    [
      '# Wiki',
      '<!-- maintained by Verity',
      'last run: today -->',
      'Overview.',
      '```',
      '## Not a topic',
      '[nor a page](fenced.md)',
      '```',
      '## Real',
      '- [Page](page.md)',
    ].join('\n'),
  );
  // A code example stays in the overview as text; it only is no topic.
  expect(index.overview).toBe('Overview.\n```\n## Not a topic\n[nor a page](fenced.md)\n```');
  expect(index.topics).toEqual([{ title: 'Real', description: '', pages: ['insights/page.md'] }]);
});

describe('projectWikiCatalog', () => {
  it('lists pages with titles, links both ways, decisions with status and what needs a look', async () => {
    write('insights/index.md', '# Wiki\n\nOverview.\n\n## Concepts\nThe ideas.\n- [Nav](nav.md)\n');
    write('insights/log.md', '# Log\n');
    write(
      'insights/nav.md',
      `# Navigation\n\nSee [the meeting](../sources/meetings/m.md), [the decision](decisions/${'b'.repeat(32)}.md) and [gone](gone.md).\n`,
    );
    write(
      'insights/topic/deep.md',
      '# Deep\n\nBack to [navigation](../nav.md) and [missing](../../sources/x.md).\n',
    );
    write('sources/meetings/m.md', 'Transcript');
    decision('a'.repeat(32), 'First', '2026-11-01T00:00:00.000Z');
    decision('b'.repeat(32), 'Second', '2026-11-02T00:00:00.000Z', 'a'.repeat(32));
    write('insights/Conflicts/c1/conflict.json', JSON.stringify({ path: 'nav.md' }));

    const catalog = await projectWikiCatalog(root);

    // The start page and the log are the Wiki's own, not pages among the rest.
    expect(catalog.pages.map((page) => page.path).sort()).toEqual([
      'insights/nav.md',
      'insights/topic/deep.md',
    ]);
    const nav = catalog.pages.find((page) => page.path === 'insights/nav.md')!;
    expect(nav).toMatchObject({
      title: 'Navigation',
      links: [
        'sources/meetings/m.md',
        `insights/decisions/${'b'.repeat(32)}.md`,
        'insights/gone.md',
      ],
      // The start page links every page, so it is no backlink.
      linkedFrom: ['insights/topic/deep.md'],
    });
    expect(catalog.index).toMatchObject({
      overview: 'Overview.',
      topics: [{ title: 'Concepts', pages: ['insights/nav.md'] }],
    });
    expect(catalog.decisions).toMatchObject([
      { id: 'b'.repeat(32), status: 'current', predecessor: 'a'.repeat(32) },
      { id: 'a'.repeat(32), status: 'superseded', successor: 'b'.repeat(32) },
    ]);
    expect(catalog.review).toEqual([
      { kind: 'edit_conflict', path: 'insights/nav.md', conflict: 'insights/Conflicts/c1' },
      { kind: 'broken_links', path: 'insights/nav.md', targets: ['insights/gone.md'] },
      { kind: 'broken_links', path: 'insights/topic/deep.md', targets: ['sources/x.md'] },
    ]);
    expect(catalog.truncated).toBe(false);
  });

  // A link planted in the Wiki must not let the catalog read, or confirm the
  // existence of, anything outside the project's knowledge.
  it('does not follow links out of the knowledge root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wiki-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), '# Secret\n\nDo not read.');
      mkdirSync(join(outside, 'dir'));
      writeFileSync(join(outside, 'dir/inner.md'), '# Inner');
      symlinkSync(join(outside, 'secret.md'), join(root, 'insights/secret.md'));
      symlinkSync(join(outside, 'dir'), join(root, 'insights/dir'));
      symlinkSync(outside, join(root, 'sources/linked'));
      write('insights/page.md', '# Page\n\n[leak](../sources/linked/secret.md)\n');
      const catalog = await projectWikiCatalog(root);
      expect(catalog.pages.map((page) => page.path)).toEqual(['insights/page.md']);
      expect(catalog.review).toEqual([
        { kind: 'broken_links', path: 'insights/page.md', targets: ['sources/linked/secret.md'] },
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a project without a Wiki yet as an empty one', async () => {
    rmSync(join(root, 'insights'), { recursive: true });
    expect(await projectWikiCatalog(root)).toEqual({
      pages: [],
      index: null,
      decisions: [],
      review: [],
      truncated: false,
    });
  });

  // The app opens any knowledge file a link names; only a link to nothing is broken.
  it('counts links to images, conflicts and skipped pages as working when the file is there', async () => {
    write('insights/diagram.png', 'png');
    write('insights/huge.md', `# Huge\n\n${'x'.repeat(600 * 1024)}`);
    write(
      'insights/page.md',
      '# Page\n\n[d](diagram.png) [h](huge.md) [s](../sources/meetings) [m](missing.png)\n',
    );
    const catalog = await projectWikiCatalog(root);
    expect(catalog.review).toEqual([
      { kind: 'broken_links', path: 'insights/page.md', targets: ['insights/missing.png'] },
    ]);
  });

  it('checks a bounded number of linked files and says when it stopped', async () => {
    const links = Array.from({ length: 205 }, (_, n) => `[x](missing-${String(n)}.png)`).join(' ');
    write('insights/many.md', `# Many\n\n${links}\n`);
    const catalog = await projectWikiCatalog(root);
    const broken = catalog.review.flatMap((item) =>
      item.kind === 'broken_links' ? item.targets : [],
    );
    expect(broken).toHaveLength(200);
    expect(catalog.truncated).toBe(true);
  });

  it('says when an oversized page was left out', async () => {
    write('insights/small.md', '# Small');
    write('insights/huge.md', `# Huge\n\n${'x'.repeat(600 * 1024)}`);
    const catalog = await projectWikiCatalog(root);
    expect(catalog.pages.map((page) => page.path)).toEqual(['insights/small.md']);
    expect(catalog.truncated).toBe(true);
  });
});
