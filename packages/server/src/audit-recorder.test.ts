import { describe, expect, it } from 'vitest';

import type { AuditEvent, AuditEventInput, AuditLog } from './audit-log.js';
import { AuditUnavailableError, createAuditRecorder, type BuildIntent } from './audit-recorder.js';

/** A log whose writes can be switched off, to stand in for an audit storage outage. */
function fakeLog() {
  const appended: AuditEventInput[] = [];
  let failing: (input: AuditEventInput) => boolean = () => false;
  const log: AuditLog = {
    append(input) {
      if (failing(input)) return Promise.reject(new Error('database unavailable'));
      appended.push(input);
      return Promise.resolve({} as AuditEvent);
    },
    listOperations: () => Promise.resolve({ operations: [], nextBefore: null }),
    operation: () => Promise.resolve([]),
    oldestRecordedAt: () => Promise.resolve(null),
  };
  return {
    log,
    appended,
    setFailing(value: boolean | ((input: AuditEventInput) => boolean)) {
      failing = typeof value === 'function' ? value : () => value;
    },
  };
}

const intent: BuildIntent = {
  projectId: 'p1',
  projectLabel: 'org/repo',
  initiator: { kind: 'user', userId: 'u1' },
  imageTag: 'verity-devc-org-repo:abc',
  forceRebuild: false,
  commit: null,
  baseImageRef: 'base:1',
  configFingerprint: 'abcdef0123',
  features: [],
};

function recorder(log: AuditLog) {
  return createAuditRecorder(log, {
    server: () => Promise.resolve({ release: '1.0.0', generation: null }),
  });
}

describe('audit recorder', () => {
  it('refuses a build whose intent cannot be stored', async () => {
    const fake = fakeLog();
    fake.setFailing(true);
    await expect(recorder(fake.log).beginBuild(intent)).rejects.toBeInstanceOf(
      AuditUnavailableError,
    );
  });

  it('records intent and outcome under one operation and tracks it as active', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    const build = await audit.beginBuild(intent);
    expect(audit.isActive(build.operationId)).toBe(true);
    await build.succeeded({ imageId: 'sha256:1', sizeBytes: 10, baseImageDigest: null });
    expect(audit.isActive(build.operationId)).toBe(false);
    expect(fake.appended.map((e) => [e.kind, e.operationId])).toEqual([
      ['build.requested', build.operationId],
      ['build.succeeded', build.operationId],
    ]);
    expect(fake.appended[1]!.imageId).toBe('sha256:1');
  });

  // A lost best-effort write leaves no row; without the gap event the trail would look
  // complete. The gap must land before the process's next event on that stream.
  it('lets best-effort writes fail and appends a write-gap event first on recovery', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    const build = await audit.beginBuild(intent);
    fake.setFailing(true);
    await build.failed();
    expect((await audit.health()).status).toBe('degraded');
    fake.setFailing(false);
    await audit.beginBuild(intent);
    expect(fake.appended.map((e) => e.kind)).toEqual([
      'build.requested',
      'audit.write_gap',
      'build.requested',
    ]);
    const gap = fake.appended[1]!;
    expect(gap.streamId).toBe('project:p1');
    expect(gap.payload).toMatchObject({ failedWrites: 1, kinds: { 'build.failed': 1 } });
    expect(await audit.health()).toEqual({ status: 'ok', pendingFailedWrites: 0 });
  });

  it('refuses the next build while its stream still owes a write-gap event', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    fake.setFailing(true);
    await audit.projectDeleted({
      projectId: 'p1',
      projectLabel: 'org/repo',
      initiator: { kind: 'user', userId: 'u1' },
    });
    // Storage is back for builds, but the owed gap event still cannot be written.
    fake.setFailing((input) => input.kind === 'audit.write_gap');
    await expect(audit.beginBuild(intent)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(fake.appended).toEqual([]);
  });

  // The Settings screen checks health on every visit; two checks in flight must not
  // record the same lost writes twice.
  it('records one write-gap event for concurrent health checks', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    fake.setFailing(true);
    await audit.imageRemoved({ imageRef: 'verity-devc-x:1' });
    fake.setFailing(false);
    await Promise.all([audit.health(), audit.health(), audit.health()]);
    expect(fake.appended.filter((e) => e.kind === 'audit.write_gap')).toHaveLength(1);
  });

  // A deletion or a finished build must never fail because its audit record did.
  it('never rejects a best-effort record, even when error reporting throws', async () => {
    const fake = fakeLog();
    const audit = createAuditRecorder(fake.log, {
      server: () => Promise.resolve({ release: '1.0.0', generation: null }),
      onError: () => {
        throw new Error('logger broken');
      },
    });
    const build = await audit.beginBuild(intent);
    fake.setFailing(true);
    await expect(
      audit.projectDeleted({
        projectId: 'p1',
        projectLabel: 'org/repo',
        initiator: { kind: 'user', userId: 'u1' },
      }),
    ).resolves.toBeUndefined();
    await expect(build.failed()).resolves.toBeUndefined();
    await expect(audit.imageRemoved({ imageRef: 'x' })).resolves.toBeUndefined();
  });

  // The gap must precede every later event on its stream, also one written while a
  // health check is still writing the gap.
  it('never lets a concurrent event overtake the write-gap event', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    fake.setFailing(true);
    await audit.projectDeleted({
      projectId: 'p1',
      projectLabel: 'org/repo',
      initiator: { kind: 'user', userId: 'u1' },
    });
    fake.setFailing(false);
    // A slow gap write opens the window in which another event could overtake it.
    const append = fake.log.append.bind(fake.log);
    fake.log.append = async (input, txn) => {
      if (input.kind === 'audit.write_gap') await new Promise((r) => setTimeout(r, 20));
      return append(input, txn);
    };
    const checking = audit.health();
    // The health check has taken the gap and is still writing it.
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([checking, audit.beginBuild(intent)]);
    expect(fake.appended.map((e) => e.kind)).toEqual(['audit.write_gap', 'build.requested']);
  });

  it('flushes outstanding gaps when health is checked', async () => {
    const fake = fakeLog();
    const audit = recorder(fake.log);
    fake.setFailing(true);
    await audit.imageRemoved({ imageRef: 'verity-devc-x:1' });
    fake.setFailing(false);
    expect((await audit.health()).status).toBe('ok');
    expect(fake.appended.map((e) => [e.kind, e.streamId])).toEqual([
      ['audit.write_gap', 'installation'],
    ]);
  });
});
