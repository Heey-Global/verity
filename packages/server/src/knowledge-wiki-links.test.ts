import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markdownLinks, resolveKnowledgeLink } from '@verity/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  countLinksTo,
  knowledgeBacklinks,
  rewritePageLinks,
  rewriteWikiLinksAfterMove,
} from './knowledge-wiki-links.js';

/** Where every link of `page` leads, by the rule the app opens links with. */
const targets = (markdown: string, page: string) =>
  markdownLinks(markdown).map(({ href }) => resolveKnowledgeLink(page, href));

describe('rewritePageLinks', () => {
  const move = { from: 'insights/topic/page.md', to: 'insights/archive/old-page.md' };

  it('points links at the new place and keeps anchors, titles and external links', () => {
    const page = 'insights/index.md';
    const before = [
      '[Page](topic/page.md) and [section](topic/page.md#decisions "Title")',
      '[Web](https://example.com/topic/page.md) [Mail](mailto:a@example.com)',
      '[Here](#local) [Absolute](/knowledge/insights/topic/page.md) [Other](topic/other.md)',
    ].join('\n');
    const { content, links } = rewritePageLinks(before, page, page, move);
    expect(links).toBe(2);
    expect(content).toBe(
      [
        '[Page](archive/old-page.md) and [section](archive/old-page.md#decisions "Title")',
        '[Web](https://example.com/topic/page.md) [Mail](mailto:a@example.com)',
        '[Here](#local) [Absolute](/knowledge/insights/topic/page.md) [Other](topic/other.md)',
      ].join('\n'),
    );
    // The app opens the rewritten links where the page now is.
    expect(targets(content, page).slice(0, 2)).toEqual([move.to, move.to]);
  });

  it('leaves code spans and fenced code untouched', () => {
    const page = 'insights/index.md';
    const before = [
      'Write `[Page](topic/page.md)` like this:',
      '```',
      '[Page](topic/page.md)',
      '```',
      '[Page](topic/page.md)',
    ].join('\n');
    const { content, links } = rewritePageLinks(before, page, page, move);
    expect(links).toBe(1);
    expect(content.split('\n')).toEqual([
      'Write `[Page](topic/page.md)` like this:',
      '```',
      '[Page](topic/page.md)',
      '```',
      '[Page](archive/old-page.md)',
    ]);
  });

  it('rewrites reference definitions, images and encoded names', () => {
    const spaced = { from: 'insights/My Page.md', to: 'insights/topic/My Page.md' };
    const page = 'insights/index.md';
    const before = '[a]: My%20Page.md\n![chart](<My Page.md>)\n[b](My%20Page.md)';
    const { content, links } = rewritePageLinks(before, page, page, spaced);
    expect(links).toBe(3);
    expect(content).toBe(
      '[a]: topic/My%20Page.md\n![chart](<topic/My Page.md>)\n[b](topic/My%20Page.md)',
    );
  });

  it("keeps a moved page's own links reaching what they reached", () => {
    const before = '[Sibling](other.md) [Up](../index.md#top) [Source](../../sources/a.pdf)';
    const { content, links } = rewritePageLinks(before, move.from, move.to, move);
    expect(links).toBe(1);
    expect(content).toBe(
      '[Sibling](../topic/other.md) [Up](../index.md#top) [Source](../../sources/a.pdf)',
    );
    expect(targets(content, move.to)).toEqual(targets(before, move.from));
  });

  it('carries a folder move to every page inside it and leaves links between them', () => {
    const folder = { from: 'insights/topic', to: 'insights/archive/topic' };
    const inside = '[Sibling](other.md) [Home](../index.md)';
    const moved = rewritePageLinks(
      inside,
      'insights/topic/page.md',
      'insights/archive/topic/page.md',
      folder,
    );
    expect(moved.content).toBe('[Sibling](other.md) [Home](../../index.md)');
    const outside = rewritePageLinks(
      '[Deep](topic/sub/page.md) [Folder](topic/)',
      'insights/index.md',
      'insights/index.md',
      folder,
    );
    expect(outside.content).toBe('[Deep](archive/topic/sub/page.md) [Folder](archive/topic/)');
  });

  it('counts links that reach an entry or anything inside a folder', () => {
    const page = 'insights/index.md';
    const markdown = '[a](topic/page.md) [b](./topic/page.md#x) [c](topic/other.md) [d](https://x)';
    expect(countLinksTo(markdown, page, 'insights/topic/page.md')).toBe(2);
    expect(countLinksTo(markdown, page, 'insights/topic')).toBe(3);
    expect(countLinksTo(markdown, page, 'insights/top')).toBe(0);
  });
});

describe('Wiki link rewriting on disk', () => {
  let scope: string;
  const write = (path: string, content: string) => {
    mkdirSync(join(scope, path, '..'), { recursive: true });
    writeFileSync(join(scope, path), content);
    chmodSync(join(scope, path), 0o666);
  };
  const read = (path: string) => readFileSync(join(scope, path), 'utf8');

  beforeEach(() => {
    scope = mkdtempSync(join(tmpdir(), 'verity-wiki-links-'));
    mkdirSync(join(scope, 'insights'));
    mkdirSync(join(scope, 'sources'));
  });
  afterEach(() => rmSync(scope, { recursive: true, force: true }));

  it('rewrites the other pages of the scope and reports what changed', async () => {
    write('insights/index.md', '[Plan](topic/plan.md) [Plan again](topic/plan.md#goals)');
    write('insights/notes.md', 'No links here.');
    write('insights/decisions/0001.md', '[Plan](../topic/plan.md)');
    // The move already happened on disk.
    write('insights/archive/plan.md', '[Home](../index.md) [Budget](budget.md)');

    const result = await rewriteWikiLinksAfterMove(scope, {
      from: 'insights/topic/plan.md',
      to: 'insights/archive/plan.md',
    });

    expect(result).toEqual({
      linksUpdated: [
        { path: 'insights/archive/plan.md', links: 1 },
        { path: 'insights/index.md', links: 2 },
      ],
    });
    expect(read('insights/index.md')).toBe(
      '[Plan](archive/plan.md) [Plan again](archive/plan.md#goals)',
    );
    expect(read('insights/archive/plan.md')).toBe(
      '[Home](../index.md) [Budget](../topic/budget.md)',
    );
    // Recorded decisions stay exactly as recorded.
    expect(read('insights/decisions/0001.md')).toBe('[Plan](../topic/plan.md)');
    // The page keeps the mode that lets the sandbox agent edit it.
    expect(statSync(join(scope, 'insights/index.md')).mode & 0o777).toBe(0o666);
  });

  it('lists the pages linking to an entry, without the pages inside it', async () => {
    write('insights/index.md', '[a](topic/a.md) [b](topic/b.md) [x](https://x)');
    write('insights/topic/a.md', '[b](b.md)');
    write('insights/other.md', '[source](../sources/call.md)');
    expect(await knowledgeBacklinks(scope, 'insights/topic')).toEqual([
      { path: 'insights/index.md', links: 2 },
    ]);
    expect(await knowledgeBacklinks(scope, 'insights/topic/b.md')).toEqual([
      { path: 'insights/index.md', links: 1 },
      { path: 'insights/topic/a.md', links: 1 },
    ]);
    expect(await knowledgeBacklinks(scope, 'sources/call.md')).toEqual([
      { path: 'insights/other.md', links: 1 },
    ]);
  });
});
