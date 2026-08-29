import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  advanceCompanionReconciliation,
  advanceCutover,
  advanceUpdate,
  archiveUpdateJournal,
  beginUpdate,
  failUpdate,
  parseUpdateJournal,
  readUpdateJournal,
  UPDATE_JOURNAL_FILE,
} from './update-journal.js';

const image = (character: string): string =>
  `ghcr.io/heey-global/verity/verity-server@sha256:${character.repeat(64)}`;
const time =
  (second: number): (() => Date) =>
  () =>
    new Date(`2026-08-09T00:00:${String(second).padStart(2, '0')}.000Z`);
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'verity-update-journal-'));
  await chmod(path, 0o700);
  return path;
}
function request(path: string) {
  return {
    root: path,
    deploymentId: 'deployment-1',
    idempotencyKey: 'request-1',
    currentGeneration: 7,
    previousDigest: image('a'),
    targetDigest: image('b'),
    now: time(1),
    randomId: () => 'update-1',
  };
}

describe('Updater journal', () => {
  it('creates a synced, checksum-protected operation with the next generation', async () => {
    const path = await root();
    const journal = await beginUpdate(request(path));
    expect(journal).toMatchObject({
      updateId: 'update-1',
      generation: 8,
      phase: 'requested',
      candidate: null,
      failure: null,
    });
    expect(await readUpdateJournal(path)).toEqual(journal);
    const persisted = JSON.parse(await readFile(join(path, UPDATE_JOURNAL_FILE), 'utf8'));
    expect(parseUpdateJournal(persisted)).toEqual(journal);
  });

  it('returns the same operation for the same key and rejects a competing target', async () => {
    const path = await root();
    const first = await beginUpdate(request(path));
    await expect(beginUpdate(request(path))).resolves.toEqual(first);
    await expect(
      beginUpdate({ ...request(path), idempotencyKey: 'request-2', targetDigest: image('c') }),
    ).rejects.toThrow(/already owns/);
  });

  it('archives only after companion reconciliation completes', async () => {
    const path = await root();
    await beginUpdate(request(path));
    for (const [from, to] of [
      ['requested', 'pulling'],
      ['pulling', 'verifying-image'],
      ['verifying-image', 'preflight'],
      ['preflight', 'creating-standby'],
    ] as const)
      await advanceUpdate(path, from, to);
    await advanceUpdate(path, 'creating-standby', 'standby', {
      candidate: { containerId: 'd'.repeat(64), containerName: 'verity-managed-server-g8' },
    });
    for (const [from, to] of [
      ['standby', 'quiescing-old'],
      ['quiescing-old', 'handing-off-key'],
      ['handing-off-key', 'activating-candidate'],
      ['activating-candidate', 'checking-candidate'],
      ['checking-candidate', 'draining-gateway'],
      ['draining-gateway', 'switching-gateway'],
      ['switching-gateway', 'observing-candidate'],
      ['observing-candidate', 'committed'],
    ] as const)
      await advanceCutover(path, from, to, { previousContainerId: 'e'.repeat(64) });
    await expect(archiveUpdateJournal(path)).rejects.toThrow(/still in progress: committed/);
    await advanceCompanionReconciliation(path, 'committed', 'reconciling-companions');
    await advanceCompanionReconciliation(path, 'reconciling-companions', 'completed');
    await expect(archiveUpdateJournal(path)).resolves.toMatchObject({ phase: 'completed' });
    await expect(
      beginUpdate({
        ...request(path),
        idempotencyKey: 'request-2',
        currentGeneration: 8,
        previousDigest: image('b'),
        targetDigest: image('c'),
      }),
    ).resolves.toMatchObject({ generation: 9, phase: 'requested' });
  });

  it('reads checksum-valid legacy journals for an in-place schema transition', () => {
    const body = {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      updateId: 'update-1',
      idempotencyKey: 'request-1',
      generation: 8,
      previousDigest: image('a'),
      targetDigest: image('b'),
      phase: 'standby',
      createdAt: time(1)().toISOString(),
      updatedAt: time(2)().toISOString(),
      candidate: { containerId: 'a'.repeat(64), containerName: 'standby-8' },
      failure: null,
    };
    const checksum = `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
    expect(parseUpdateJournal({ ...body, checksum })).toMatchObject({
      schemaVersion: 2,
      previousContainerId: null,
      phase: 'standby',
    });
    expect(parseUpdateJournal({ ...body, checksum, generation: 9 })).toBeNull();
  });

  it('persists only the strict preparation sequence and requires a candidate at standby', async () => {
    const path = await root();
    await beginUpdate(request(path));
    await advanceUpdate(path, 'requested', 'pulling', { now: time(2) });
    await advanceUpdate(path, 'pulling', 'verifying-image', { now: time(3) });
    await advanceUpdate(path, 'verifying-image', 'preflight', { now: time(4) });
    await advanceUpdate(path, 'preflight', 'creating-standby', { now: time(5) });
    await expect(
      advanceUpdate(path, 'creating-standby', 'standby', { now: time(6) }),
    ).rejects.toThrow(/invalid/);
    const standby = await advanceUpdate(path, 'creating-standby', 'standby', {
      now: time(6),
      candidate: { containerId: 'a'.repeat(64), containerName: 'verity-standby-update-1' },
    });
    expect(standby).toMatchObject({ phase: 'standby', candidate: { containerId: 'a'.repeat(64) } });
    await expect(advanceUpdate(path, 'standby', 'requested')).rejects.toThrow(/invalid/);
  });

  it('records only a bounded failure code and retains recovery identity', async () => {
    const path = await root();
    const requested = await beginUpdate(request(path));
    const failed = await failUpdate(path, 'requested', 'release-verification-failed', time(2));
    expect(failed).toMatchObject({
      updateId: requested.updateId,
      generation: requested.generation,
      phase: 'failed',
      failure: { code: 'release-verification-failed' },
    });
  });

  it('fails closed for corruption, hostile permissions, and stale phase writers', async () => {
    const path = await root();
    await beginUpdate(request(path));
    const persisted = JSON.parse(await readFile(join(path, UPDATE_JOURNAL_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    persisted.targetDigest = image('c');
    await writeFile(join(path, UPDATE_JOURNAL_FILE), JSON.stringify(persisted));
    await expect(readUpdateJournal(path)).rejects.toThrow(/corrupt/);

    const insecure = await root();
    await chmod(insecure, 0o777);
    await expect(beginUpdate(request(insecure))).rejects.toThrow(/private updater-owned/);

    const stale = await root();
    await beginUpdate(request(stale));
    await advanceUpdate(stale, 'requested', 'pulling', { now: time(2) });
    await expect(failUpdate(stale, 'requested', 'late-failure')).rejects.toThrow(/phase changed/);
  });

  it('rejects permissive and symlink-substituted journal files', async () => {
    const permissive = await root();
    await beginUpdate(request(permissive));
    await chmod(join(permissive, UPDATE_JOURNAL_FILE), 0o644);
    await expect(readUpdateJournal(permissive)).rejects.toThrow(/private updater-owned/);

    const substituted = await root();
    await beginUpdate(request(substituted));
    const moved = join(substituted, 'moved-journal.json');
    await rename(join(substituted, UPDATE_JOURNAL_FILE), moved);
    await symlink(moved, join(substituted, UPDATE_JOURNAL_FILE));
    await expect(readUpdateJournal(substituted)).rejects.toThrow();
  });
});

/**
 * The parser is the journal's integrity boundary: every write goes back through
 * it before it is persisted, and every read comes back through it before
 * anything acts on it. A phase, a candidate container id, or a failure code
 * that got through here would be treated as durable intent by crash recovery
 * and reported to the operator as the state of their update.
 *
 * Pure — no journal root, no `/proc`, no lease — so it is the one part of this
 * module that can be pinned down exhaustively.
 */
describe('the update journal parser', () => {
  const CANDIDATE = { containerId: 'a'.repeat(64), containerName: 'verity-managed-server-g8' };
  const PREVIOUS = 'b'.repeat(12);

  /** The same document minus one field, so a narrowed key set can be tested. */
  function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
    const copy = { ...value };
    delete copy[key];
    return copy;
  }

  /**
   * A checksum-consistent document, so a rejection below is always the field
   * under test and never the seal. Key order follows the writer's, which is
   * what the checksum is taken over.
   */
  function sealed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const body = {
      schemaVersion: 2,
      deploymentId: 'deployment-1',
      updateId: 'update-1',
      idempotencyKey: 'request-1',
      generation: 8,
      previousDigest: image('a'),
      targetDigest: image('b'),
      phase: 'requested',
      createdAt: time(1)().toISOString(),
      updatedAt: time(2)().toISOString(),
      candidate: null,
      previousContainerId: null,
      failure: null,
      ...overrides,
    };
    return {
      ...body,
      checksum: `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`,
    };
  }

  it('accepts each shape an operation legitimately reaches', () => {
    expect(parseUpdateJournal(sealed())).toMatchObject({
      phase: 'requested',
      generation: 8,
      candidate: null,
      previousContainerId: null,
      failure: null,
    });
    expect(parseUpdateJournal(sealed({ phase: 'standby', candidate: CANDIDATE }))).toMatchObject({
      phase: 'standby',
      candidate: CANDIDATE,
      previousContainerId: null,
    });
    expect(
      parseUpdateJournal(
        sealed({
          phase: 'switching-gateway',
          candidate: CANDIDATE,
          previousContainerId: PREVIOUS,
        }),
      ),
    ).toMatchObject({
      phase: 'switching-gateway',
      candidate: CANDIDATE,
      previousContainerId: PREVIOUS,
    });
    expect(
      parseUpdateJournal(sealed({ phase: 'failed', failure: { code: 'pulling-failed' } })),
    ).toMatchObject({ phase: 'failed', failure: { code: 'pulling-failed' } });
  });

  it('rejects a document whose identifying fields do not describe an operation', () => {
    for (const overrides of [
      { schemaVersion: 3 },
      { deploymentId: '' },
      { deploymentId: '-leading-dash' },
      { deploymentId: 7 },
      { updateId: 'not a key' },
      { idempotencyKey: null },
      // Generations are the fence the whole self-update depends on.
      { generation: 0 },
      { generation: -1 },
      { generation: 1.5 },
      { generation: '8' },
      { previousDigest: 'latest' },
      { previousDigest: image('A') },
      { targetDigest: `ghcr.io/other/verity-server@sha256:${'b'.repeat(64)}` },
      { phase: 'nearly-done' },
      { phase: 7 },
      // Not a timestamp at all, and a timestamp not in the canonical form the
      // writer emits — the second would compare wrongly against `createdAt`.
      { createdAt: 5 },
      { createdAt: '2026-08-09T00:00:01Z' },
      { updatedAt: 'yesterday' },
      // Time running backwards means one of the two writes is not this one.
      { createdAt: time(2)().toISOString(), updatedAt: time(1)().toISOString() },
    ])
      expect(parseUpdateJournal(sealed(overrides))).toBeNull();

    expect(parseUpdateJournal(null)).toBeNull();
    expect(parseUpdateJournal([sealed()])).toBeNull();
    // Widened and narrowed documents are both refused: the key set is exact.
    expect(parseUpdateJournal(without(sealed(), 'failure'))).toBeNull();
    expect(parseUpdateJournal({ ...sealed(), note: 'x' })).toBeNull();
    // The seal itself.
    expect(parseUpdateJournal({ ...sealed(), checksum: `sha256:${'0'.repeat(64)}` })).toBeNull();
    expect(parseUpdateJournal({ ...sealed(), checksum: 7 })).toBeNull();
  });

  it('rejects a candidate, previous container, or failure record it cannot trust', () => {
    for (const candidate of [
      5,
      'a'.repeat(64),
      [CANDIDATE],
      { containerId: CANDIDATE.containerId },
      { ...CANDIDATE, image: image('b') },
      // Not a container id: the Updater would later stop or promote by this.
      { ...CANDIDATE, containerId: 'zz' },
      { ...CANDIDATE, containerId: 'a'.repeat(11) },
      { ...CANDIDATE, containerId: 7 },
      { ...CANDIDATE, containerName: 'not a name' },
      { ...CANDIDATE, containerName: null },
    ])
      expect(parseUpdateJournal(sealed({ phase: 'standby', candidate }))).toBeNull();

    for (const previousContainerId of ['zz', 'a'.repeat(11), 7, {}])
      expect(
        parseUpdateJournal(
          sealed({ phase: 'switching-gateway', candidate: CANDIDATE, previousContainerId }),
        ),
      ).toBeNull();

    for (const failure of [
      'pulling-failed',
      { code: 7 },
      { code: 'not a code' },
      { code: 'pulling-failed', detail: 'x' },
      {},
    ])
      expect(parseUpdateJournal(sealed({ phase: 'failed', failure }))).toBeNull();
  });

  /**
   * The cross-field rules, which are what make the phase a reliable statement
   * about the world. Each of these documents is individually well-formed and
   * correctly sealed; it is refused because the phase and the recorded facts
   * describe two different situations.
   */
  it('rejects a journal whose phase and recorded facts disagree', () => {
    // A candidate exists from `standby` onwards, and only from there.
    expect(parseUpdateJournal(sealed({ phase: 'standby', candidate: null }))).toBeNull();
    expect(
      parseUpdateJournal(sealed({ phase: 'quiescing-old', previousContainerId: PREVIOUS })),
    ).toBeNull();
    expect(parseUpdateJournal(sealed({ phase: 'pulling', candidate: CANDIDATE }))).toBeNull();
    expect(
      parseUpdateJournal(sealed({ phase: 'failed', candidate: CANDIDATE, failure: { code: 'x' } })),
    ).toBeNull();

    // The outgoing container's identity is recorded exactly across the cutover:
    // a rollback has nothing to reactivate without it.
    expect(
      parseUpdateJournal(
        sealed({
          phase: 'rollback-activating-old',
          candidate: CANDIDATE,
          previousContainerId: null,
        }),
      ),
    ).toBeNull();
    expect(
      parseUpdateJournal(
        sealed({ phase: 'standby', candidate: CANDIDATE, previousContainerId: PREVIOUS }),
      ),
    ).toBeNull();

    // `failed` and a failure code imply each other in both directions.
    expect(parseUpdateJournal(sealed({ phase: 'failed', failure: null }))).toBeNull();
    expect(parseUpdateJournal(sealed({ failure: { code: 'pulling-failed' } }))).toBeNull();
    expect(
      parseUpdateJournal(
        sealed({ phase: 'completed', candidate: CANDIDATE, previousContainerId: PREVIOUS }),
      ),
    ).toMatchObject({ phase: 'completed', failure: null });
  });

  it('rejects a legacy journal that is not exactly the legacy shape', () => {
    const legacy = {
      schemaVersion: 1,
      deploymentId: 'deployment-1',
      updateId: 'update-1',
      idempotencyKey: 'request-1',
      generation: 8,
      previousDigest: image('a'),
      targetDigest: image('b'),
      phase: 'requested',
      createdAt: time(1)().toISOString(),
      updatedAt: time(2)().toISOString(),
      candidate: null,
      failure: null,
    };
    const checksum = `sha256:${createHash('sha256').update(JSON.stringify(legacy)).digest('hex')}`;
    expect(parseUpdateJournal({ ...legacy, checksum })).toMatchObject({
      schemaVersion: 2,
      phase: 'requested',
      previousContainerId: null,
    });
    // A v1 document is only read as v1 when it is exactly that shape: no
    // checksum, an unreadable one, a v2 field, or a missing one all fail closed
    // rather than being reinterpreted under the other schema.
    expect(parseUpdateJournal(legacy)).toBeNull();
    expect(parseUpdateJournal({ ...legacy, checksum: 7 })).toBeNull();
    expect(parseUpdateJournal({ ...legacy, checksum, previousContainerId: null })).toBeNull();
    expect(parseUpdateJournal(without({ ...legacy, checksum }, 'failure'))).toBeNull();
  });
});

/**
 * The companion transaction is refused by name before the journal root is even
 * opened, so a caller that asked for the wrong step is told which step it asked
 * for rather than being told the root is unreadable.
 */
describe('the companion reconciliation transition guard', () => {
  it('names the transition it refuses before it opens anything', async () => {
    await expect(
      advanceCompanionReconciliation('/nonexistent-journal-root', 'committed', 'completed'),
    ).rejects.toThrow('invalid companion phase transition: committed -> completed');
    await expect(
      advanceCompanionReconciliation(
        '/nonexistent-journal-root',
        'reconciling-companions',
        'reconciling-companions',
      ),
    ).rejects.toThrow(
      'invalid companion phase transition: reconciling-companions -> reconciling-companions',
    );
  });
});
