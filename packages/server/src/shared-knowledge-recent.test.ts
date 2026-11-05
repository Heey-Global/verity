import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { describeHead, recentSharedKnowledge } from './shared-knowledge-recent.js';

let root: string;
let outside: string;

function write(path: string, content: string, minutesAgo: number) {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(file, at, at);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-recent-'));
  outside = mkdtempSync(join(tmpdir(), 'shared-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const decision = (title: string) =>
  `<!-- verity-decision:v1 {"version":1,"id":"d1","sessionId":"s-42","createdAt":"2026-11-03T16:14:02.187Z"} -->\n# ${title}\n\nBody.`;

it('lists the newest pages first, named by their heading and area', async () => {
  write('insights/tone.md', '# Tone of voice\n\nWrite plainly.', 30);
  write('insights/decisions/d1.md', decision('Verity owns Global'), 5);
  write('sources/documents/brief.txt', 'Raw text', 10);
  const { entries: recent, truncated } = await recentSharedKnowledge(root, 8);
  expect(truncated).toBe(false);
  expect(recent.map((entry) => [entry.path, entry.area, entry.title])).toEqual([
    ['insights/decisions/d1.md', 'decisions', 'Verity owns Global'],
    ['sources/documents/brief.txt', 'sources', 'brief'],
    ['insights/tone.md', 'wiki', 'Tone of voice'],
  ]);
  // Only a confirmed decision carries provenance; it comes from its header.
  expect(recent[0]!.decision).toEqual({
    sessionId: 's-42',
    confirmedAt: '2026-11-03T16:14:02.187Z',
  });
  expect(recent[1]!.decision).toBeUndefined();
});

it('stops at the limit and at the scan bound', async () => {
  for (let i = 0; i < 6; i += 1) write(`insights/page-${String(i)}.md`, `# Page ${String(i)}`, i);
  expect((await recentSharedKnowledge(root, 2)).entries).toHaveLength(2);
  // With a scan bound below the library size the walk stops early, so the
  // page never waits on a huge library; it returns what it saw and says so,
  // since newer pages may lie beyond the bound.
  const bounded = await recentSharedKnowledge(root, 20, 3);
  expect(bounded.entries).toHaveLength(3);
  expect(bounded.truncated).toBe(true);
});

it('never follows links or reads hidden and derived entries', async () => {
  writeFileSync(join(outside, 'secret.md'), '# Outside the library');
  mkdirSync(join(root, 'insights'), { recursive: true });
  symlinkSync(outside, join(root, 'insights/escape'));
  symlinkSync(join(outside, 'secret.md'), join(root, 'insights/linked.md'));
  write('insights/.draft.md', '# Hidden', 0);
  write('insights/mockups/_src/__pycache__/gen.pyc', 'bytes', 0);
  write('insights/visible.md', '# Visible', 1);
  const { entries } = await recentSharedKnowledge(root, 20);
  expect(entries.map((entry) => entry.path)).toEqual(['insights/visible.md']);
});

it('keeps a file with a damaged decision header, without provenance', () => {
  expect(
    describeHead('insights/decisions/x.md', '<!-- verity-decision:v1 {nope} -->\n# Kept'),
  ).toEqual({ title: 'Kept' });
});
