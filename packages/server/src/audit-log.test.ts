import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_GENESIS_HASH,
  AUDIT_INSTALLATION_STREAM,
  auditEventHash,
  createPostgresAuditLog,
  projectAuditStream,
  type AuditEventInput,
  type AuditLog,
} from './audit-log.js';

let ctx: TestDb;
let log: AuditLog;

beforeAll(async () => {
  ctx = await createTestDb();
  log = createPostgresAuditLog(ctx.db);
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

const server = { release: '4.57.3', generation: 14 };

function requested(operationId: string, projectId = 'p1', label = 'org/repo'): AuditEventInput {
  return {
    kind: 'build.requested',
    operationId,
    streamId: projectAuditStream(projectId),
    projectId,
    projectLabel: label,
    initiator: { kind: 'session', sessionId: 's1', userId: 'u1' },
    server,
    payload: {
      imageTag: 'verity-devc-org-repo:abc123def456',
      forceRebuild: false,
      commit: '9c1e4a7',
      baseImageRef: 'ghcr.io/heey-global/verity-sandbox:4.57.0',
      configFingerprint: 'abcdef0123456789',
      features: ['ghcr.io/devcontainers/features/node:1'],
    },
  };
}

function succeeded(operationId: string, imageId: string, projectId = 'p1'): AuditEventInput {
  return {
    kind: 'build.succeeded',
    operationId,
    streamId: projectAuditStream(projectId),
    projectId,
    projectLabel: 'org/repo',
    imageId,
    initiator: { kind: 'session', sessionId: 's1', userId: 'u1' },
    server,
    payload: { imageId, sizeBytes: 11_700_000_000, baseImageDigest: null, durationMs: 1000 },
  };
}

describe('audit log', () => {
  it('chains each stream on its own counter and hashes the stored envelope', async () => {
    const a = await log.append(requested('op-a'));
    const b = await log.append(succeeded('op-a', 'sha256:3f9a'));
    const other = await log.append(requested('op-b', 'p2'));
    expect([a.sequence, b.sequence, other.sequence]).toEqual([0, 1, 0]);
    expect(a.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(b.prevHash).toBe(a.eventHash);
    const { eventHash, ...rest } = b;
    expect(auditEventHash(rest)).toBe(eventHash);
    const streams = await ctx.db.selectFrom('audit_streams').selectAll().execute();
    expect(Object.fromEntries(streams.map((s) => [s.stream_id, s.next_sequence]))).toEqual({
      [projectAuditStream('p1')]: 2,
      [projectAuditStream('p2')]: 1,
    });
  });

  // The allowlist is the only thing keeping build output or credentials out of a
  // durable store; an extra key must be refused, not silently dropped.
  it('refuses payload fields outside the allowlist', async () => {
    const input = requested('op-x');
    await expect(
      log.append({ ...input, payload: { ...input.payload, buildLog: 'token=…' } } as never),
    ).rejects.toThrow();
    expect(await ctx.db.selectFrom('audit_events').selectAll().execute()).toEqual([]);
  });

  it('keeps an operation readable without its project row', async () => {
    await log.append(requested('op-a', 'deleted-project'));
    const events = await log.operation('op-a');
    expect(events.map((e) => e.kind)).toEqual(['build.requested']);
    expect(events[0]!.projectLabel).toBe('org/repo');
  });

  it('lists operations newest first, filters by domain and finds an image', async () => {
    await log.append(requested('op-old'));
    await log.append(succeeded('op-old', 'sha256:3f9ac21'));
    await log.append({
      kind: 'image.removed',
      operationId: 'op-gc',
      streamId: AUDIT_INSTALLATION_STREAM,
      imageId: 'sha256:aaaa',
      initiator: { kind: 'system', trigger: 'image_cleanup' },
      server,
      payload: { imageRef: 'verity-devc-org-repo:old', reason: 'cleanup' },
    });
    const all = await log.listOperations({});
    expect(all.operations.map((ops) => ops[0]!.operationId)).toEqual(['op-gc', 'op-old']);
    expect(all.operations[1]!.map((e) => e.kind)).toEqual(['build.requested', 'build.succeeded']);

    const builds = await log.listOperations({ domain: 'builds' });
    expect(builds.operations.map((ops) => ops[0]!.operationId)).toEqual(['op-old']);

    // A search that matches one event of an operation returns the whole operation.
    const found = await log.listOperations({ search: 'sha256:3f9a' });
    expect(found.operations.map((ops) => ops.length)).toEqual([2]);
    expect((await log.listOperations({ search: 'org/re' })).operations).toHaveLength(1);
    expect((await log.listOperations({ search: 'op-gc' })).operations).toHaveLength(1);
    expect((await log.listOperations({ search: '%' })).operations).toHaveLength(0);
  });

  it('pages with a cursor and reports the retention boundary', async () => {
    for (const id of ['op-1', 'op-2', 'op-3']) await log.append(requested(id));
    const first = await log.listOperations({ limit: 2 });
    expect(first.operations).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();
    const second = await log.listOperations({ limit: 2, before: first.nextBefore! });
    expect(second.operations.map((ops) => ops[0]!.operationId)).toEqual(['op-1']);
    expect(second.nextBefore).toBeNull();
    expect(await log.oldestRecordedAt()).toBe((await log.operation('op-1'))[0]!.recordedAt);
  });

  // A time-only cursor drops every operation that started in the same instant as the
  // last one on the page.
  it('neither skips nor repeats operations that started at the same instant', async () => {
    for (const id of ['op-a', 'op-b', 'op-c']) await log.append(requested(id));
    await ctx.db
      .updateTable('audit_events')
      .set({ recorded_at: '2026-10-27T10:00:00Z' } as never)
      .execute();
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await log.listOperations({ limit: 1, before });
      seen.push(...result.operations.map((ops) => ops[0]!.operationId));
      if (result.nextBefore === null) break;
      before = result.nextBefore;
    }
    expect(seen).toEqual(['op-c', 'op-b', 'op-a']);
  });

  // A filter that matches only a later event must not move the operation in the
  // list: it started when its first event was written.
  it('orders filtered operations by when they started', async () => {
    await log.append(requested('op-first'));
    await log.append(requested('op-second'));
    await log.append(succeeded('op-second', 'sha256:feed01'));
    await log.append(succeeded('op-first', 'sha256:feed02'));
    const found = await log.listOperations({ search: 'feed0' });
    expect(found.operations.map((ops) => ops[0]!.operationId)).toEqual(['op-second', 'op-first']);
  });
  it('filters and pages by operation start while retaining outcomes outside the window', async () => {
    const first = await log.append(requested('first'));
    const second = await log.append(requested('second'));
    await log.append(succeeded('second', 'sha256:second'));
    const third = await log.append(requested('third'));
    const window = { since: first.recordedAt, until: second.recordedAt, limit: 1 };
    const page = await log.listOperations(window);
    expect(page.operations.map((events) => events[0]!.operationId)).toEqual(['second']);
    expect(page.operations[0]!.map((event) => event.kind)).toEqual([
      'build.requested',
      'build.succeeded',
    ]);
    expect(page.nextBefore).not.toBeNull();
    const older = await log.listOperations({ ...window, before: page.nextBefore! });
    expect(older.operations.map((events) => events[0]!.operationId)).toEqual(['first']);
    expect(older.nextBefore).toBeNull();
    expect((await log.listOperations({ since: third.recordedAt })).operations).toHaveLength(1);
  });
});

it('pages individual events with equal timestamps without merging a build or skipping ties', async () => {
  const first = await log.append(requested('same-build'));
  const second = await log.append(succeeded('same-build', 'sha256:result'));
  const third = await log.append(requested('other-build', 'p2'));
  const at = '2026-10-29T12:00:00.000Z';
  await ctx.db
    .updateTable('audit_events')
    .set({ recorded_at: at } as never)
    .execute();
  const expected = [first, second, third]
    .map((e) => e.eventId)
    .sort()
    .reverse();
  const ids: string[] = [];
  let before: string | undefined;
  for (let index = 0; index < 5; index++) {
    const page = await log.listEvents({
      limit: 1,
      before,
      since: '2026-10-29T11:00:00Z',
      until: '2026-10-29T13:00:00Z',
    });
    ids.push(...page.events.map((e) => e.eventId));
    before = page.nextBefore ?? undefined;
    if (!before) break;
  }
  expect(ids).toEqual(expected);
  expect((await log.listEvents({ since: '2026-10-29T13:00:00Z' })).events).toEqual([]);
  expect((await log.listEvents({ until: '2026-10-29T11:00:00Z' })).events).toEqual([]);
  expect((await log.listEvents({ domain: 'images' })).events).toEqual([]);
  expect((await log.listEvents({ search: 'result' })).events.map((e) => e.eventId)).toEqual([
    second.eventId,
  ]);
});
