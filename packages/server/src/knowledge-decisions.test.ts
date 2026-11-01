import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordProjectDecision,
  lookupProjectDecisions,
  projectDecisionDirectory,
} from './knowledge-decisions.js';
import { DocumentWorkspace } from './document-workspace.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'decision-test-'));
  roots.push(root);
  return root;
}
const source = { sessionId: 's', confirmationMessageSeq: 7 };
const input = {
  operation: 'record_decision' as const,
  requestId: 'retention',
  title: 'Export retention',
  decision: 'Retain project exports for 30 days.',
  rationale: 'Storage budget.',
};
const lookup = { operation: 'lookup_decisions' as const };

it('persists evidence, deduplicates exact retries and retains superseded revisions', async () => {
  const root = await setup();
  const saved = await recordProjectDecision(root, 'p', source, input);
  expect(saved.saved).toBe(true);
  expect((await recordProjectDecision(root, 'p', source, input)).replayed).toBe(true);
  await expect(
    recordProjectDecision(root, 'p', source, { ...input, decision: 'Different' }),
  ).rejects.toThrow('conflicts');
  const before = await lookupProjectDecisions(root, 'p', { ...lookup, query: 'exports 30' });
  expect(before.records).toHaveLength(1);
  expect(before.records[0]?.markdown).toContain('Session s, user message 7');
  expect(before.records[0]?.markdown).toContain('Storage budget.');
  const revised = await recordProjectDecision(
    root,
    'p',
    { ...source, confirmationMessageSeq: 8 },
    {
      ...input,
      requestId: 'retention-revised',
      decision: 'Retain project exports for 60 days.',
      predecessor: { id: saved.id, digest: saved.digest },
    },
  );
  const after = await lookupProjectDecisions(root, 'p', lookup);
  expect(after.records.find((record) => record.metadata.id === saved.id)?.status).toBe(
    'superseded',
  );
  expect(after.records.find((record) => record.metadata.id === revised.id)?.status).toBe('current');
  expect((await lookupProjectDecisions(root, 'other-project', lookup)).records).toEqual([]);
  expect(await projectDecisionDirectory(root, 'p')).toContain(revised.path);
});

it('rejects stale digests and one of two concurrent revisions without overwriting either decision', async () => {
  const root = await setup();
  const saved = await recordProjectDecision(root, 'p', source, input);
  const revision = { ...input, predecessor: { id: saved.id, digest: saved.digest } };
  const results = await Promise.allSettled([
    recordProjectDecision(root, 'p', source, { ...revision, requestId: 'a' }),
    recordProjectDecision(root, 'p', source, { ...revision, requestId: 'b' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await lookupProjectDecisions(root, 'p', lookup)).records).toHaveLength(2);
  await expect(
    recordProjectDecision(root, 'p', source, {
      ...revision,
      requestId: 'c',
      predecessor: { id: saved.id, digest: '0'.repeat(64) },
    }),
  ).rejects.toThrow('predecessor');
});

it('supports manual body edits, invalidates stale retries and exposes malformed/deleted records', async () => {
  const root = await setup();
  const saved = await recordProjectDecision(root, 'p', source, input);
  const path = join(root, 'knowledge/p/insights/decisions', `${saved.id}.md`);
  await writeFile(path, (await readFile(path, 'utf8')).replace('30 days', '45 days'));
  expect(
    (await lookupProjectDecisions(root, 'p', { ...lookup, query: '45' })).records,
  ).toHaveLength(1);
  await expect(recordProjectDecision(root, 'p', source, input)).rejects.toThrow('manually edited');
  await writeFile(path, '# Missing metadata');
  const invalid = await lookupProjectDecisions(root, 'p', lookup);
  expect(invalid.incomplete).toBe(true);
  expect(invalid.warnings.join()).toContain('invalid');
  await expect(
    recordProjectDecision(root, 'p', source, { ...input, requestId: 'new' }),
  ).rejects.toThrow('blocked');
  await rm(path);
  expect((await lookupProjectDecisions(root, 'p', lookup)).records).toEqual([]);
});

it('marks a missing predecessor as unresolved instead of treating its successor as authoritative', async () => {
  const root = await setup();
  const saved = await recordProjectDecision(root, 'p', source, input);
  await recordProjectDecision(root, 'p', source, {
    ...input,
    requestId: 'revision',
    predecessor: { id: saved.id, digest: saved.digest },
  });
  await rm(join(root, 'knowledge/p/insights/decisions', `${saved.id}.md`));
  const result = await lookupProjectDecisions(root, 'p', lookup);
  expect(result.records[0]?.status).toBe('unresolved');
  expect(result.warnings.join()).toContain('predecessor');
});

it('shares publication locking and retains concurrent manual edits in Documents conflicts', async () => {
  const root = await setup();
  const saved = await recordProjectDecision(root, 'p', source, input);
  const documents = join(root, 'knowledge/p/insights');
  const a = new DocumentWorkspace(documents, join(root, 'view-a'), join(root, 'state-a'));
  const b = new DocumentWorkspace(documents, join(root, 'view-b'), join(root, 'state-b'));
  await a.prepare();
  await b.prepare();
  const path = `decisions/${saved.id}.md`;
  for (const [view, value] of [
    [a.view, '31 days'],
    [b.view, '32 days'],
  ]) {
    await writeFile(
      join(view!, path),
      (await readFile(join(view!, path), 'utf8')).replace('30 days', value!),
    );
  }
  await a.publish();
  expect((await b.publish()).conflicts).toHaveLength(1);
  expect((await lookupProjectDecisions(root, 'p', lookup)).records[0]?.markdown).toContain(
    '31 days',
  );
  const revision = await recordProjectDecision(root, 'p', source, {
    ...input,
    requestId: 'another',
  });
  await b.publish();
  expect(
    (await lookupProjectDecisions(root, 'p', { ...lookup, id: revision.id })).records,
  ).toHaveLength(1);
  await a.prepare();
  expect(await readFile(join(a.view, `decisions/${revision.id}.md`), 'utf8')).toContain(
    input.decision,
  );
});

it('refuses symlink directories and never writes outside the project', async () => {
  const root = await setup();
  await recordProjectDecision(root, 'p', source, input);
  await rm(join(root, 'knowledge/p/insights/decisions'), { recursive: true });
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'knowledge/p/insights/decisions'));
  await expect(
    recordProjectDecision(root, 'p', source, { ...input, requestId: 'escape' }),
  ).rejects.toThrow('blocked');
  const result = await lookupProjectDecisions(root, 'p', lookup);
  expect(result.incomplete).toBe(true);
  expect(result.records).toEqual([]);
});

it('bounds context, pages lookups and reports an oversized record', async () => {
  const root = await setup();
  for (let i = 0; i < 24; i++)
    await recordProjectDecision(root, 'p', source, {
      ...input,
      requestId: `item-${i}`,
      title: 'A'.repeat(160),
    });
  const first = await lookupProjectDecisions(root, 'p', lookup);
  expect(first.records).toHaveLength(10);
  expect(first.nextOffset).toBe(10);
  expect(
    (await lookupProjectDecisions(root, 'p', { ...lookup, offset: 10 })).records.map(
      (record) => record.metadata.id,
    ),
  ).not.toEqual(first.records.map((record) => record.metadata.id));
  expect((await projectDecisionDirectory(root, 'p')).length).toBeLessThan(6500);
  await writeFile(join(root, 'knowledge/p/insights/decisions/oversized.md'), 'x'.repeat(24_001));
  expect((await lookupProjectDecisions(root, 'p', lookup)).incomplete).toBe(true);
});

it('surfaces manually introduced competing revisions and cycles instead of selecting a winner', async () => {
  const root = await setup();
  const first = await recordProjectDecision(root, 'p', source, input);
  const second = await recordProjectDecision(root, 'p', source, {
    ...input,
    requestId: 'replacement',
    predecessor: { id: first.id, digest: first.digest },
  });
  const competing = await recordProjectDecision(root, 'p', source, {
    ...input,
    requestId: 'independent',
  });
  const file = (id: string) => join(root, 'knowledge/p/insights/decisions', `${id}.md`);
  await writeFile(
    file(competing.id),
    (await readFile(file(competing.id), 'utf8')).replace(
      '"version":1,',
      `"version":1,"predecessor":"${first.id}",`,
    ),
  );
  let result = await lookupProjectDecisions(root, 'p', lookup);
  expect(result.warnings.join()).toContain('competing revisions');
  expect(result.records.every((record) => record.status === 'unresolved')).toBe(true);
  await writeFile(
    file(first.id),
    (await readFile(file(first.id), 'utf8')).replace(
      '"version":1,',
      `"version":1,"predecessor":"${second.id}",`,
    ),
  );
  result = await lookupProjectDecisions(root, 'p', lookup);
  expect(result.warnings.join()).toContain('cyclic');
  await expect(
    recordProjectDecision(root, 'p', source, { ...input, requestId: 'blocked' }),
  ).rejects.toThrow('blocked');
});
