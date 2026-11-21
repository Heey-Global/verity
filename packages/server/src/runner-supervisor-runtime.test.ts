import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startRunnerSupervisorReconciler } from './embedded-support.js';
import {
  acquireSingleton,
  claimTurn,
  listTurns,
  readTurnState,
  probeSupervisor,
  validateRuntimeDirectory,
  validateRuntimeStats,
  validateStartTurnRequest,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import {
  brokerSocketOwnership,
  validateRunnerRuntimeStats,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { execFileAsync, runSupervisor } from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('accepts a server-owned runner runtime only through the runner group', () => {
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040070 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    // Server-owned with a bare owner traverse bit (0170, --x) is accepted so the
    // same-uid sandbox agent can descend to its transcript dir under claude/.
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040170 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1101, gid: 1101, mode: 0o040770 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040770 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).toThrow(/ownership mismatch/u);
    // Owner read (0570) exposes the Runner's control files to the same-uid agent —
    // still rejected; only a bare traverse bit is tolerated.
    expect(() =>
      validateRunnerRuntimeStats(
        { uid: 1000, gid: 1101, mode: 0o040570 },
        { runnerUid: 1101, runnerGid: 1101 },
      ),
    ).toThrow(/ownership mismatch/u);
  });

  it('keeps the root broker socket root-owned and runner-group writable', () => {
    expect(brokerSocketOwnership({ runnerUid: 1101, runnerGid: 1101 })).toEqual({
      uid: 0,
      gid: 1101,
      mode: 0o660,
    });
    expect(brokerSocketOwnership({ runnerUid: 1101, runnerGid: 1101, enforceRoot: false })).toEqual(
      {
        uid: 1101,
        gid: 1101,
        mode: 0o600,
      },
    );
  });

  it('reconciles on a fixed interval without overlapping slow passes', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reconcile = vi.fn(async () => await new Promise<void>((resolve) => (release = resolve)));
    const stop = startRunnerSupervisorReconciler(reconcile, 10);
    try {
      await vi.advanceTimersByTimeAsync(35);
      expect(reconcile).toHaveBeenCalledTimes(1);
      release?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(reconcile).toHaveBeenCalledTimes(2);
      const stopped = stop();
      release?.();
      await stopped;
      await vi.advanceTimersByTimeAsync(30);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });

  it('rate-limits watchdog failure reports', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const reconcile = vi.fn(async () => await Promise.reject(new Error('docker unavailable')));
    const stop = startRunnerSupervisorReconciler(reconcile, 10, report, 60);
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(reconcile).toHaveBeenCalledTimes(5);
      expect(report).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(report).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });

  it('validates owner/group-only runtime permissions', async () => {
    await expect(validateRuntimeDirectory(runtimeDir)).resolves.toBeUndefined();
    await chmod(runtimeDir, 0o777);
    await expect(validateRuntimeDirectory(runtimeDir)).rejects.toThrow(/group-only/);
  });

  it('accepts a server-owned supervisor runtime through the runner group', () => {
    const directory = { isDirectory: () => true, isSymbolicLink: () => false };
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040070 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    // Server-owned with a bare owner traverse bit (0170, --x) is accepted so the
    // same-uid sandbox agent can descend to its transcript dir under claude/.
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040170 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1101, gid: 1101, mode: 0o040770 },
        { uid: 1101, gid: 1101 },
      ),
    ).not.toThrow();
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040770 },
        { uid: 1101, gid: 1101 },
      ),
    ).toThrow(/uid mismatch/u);
    // Owner read (0570) would expose the Runner's control files to the same-uid
    // agent — still rejected; only a bare traverse bit is tolerated.
    expect(() =>
      validateRuntimeStats(
        { ...directory, uid: 1000, gid: 1101, mode: 0o040570 },
        { uid: 1101, gid: 1101 },
      ),
    ).toThrow(/uid mismatch/u);
  });

  it('replays a start only within the same supervisor instance', async () => {
    const first = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(first.outcome).toBe('created');

    const replay = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(replay.outcome).toBe('already-running');
    expect(replay.state?.runnerInstanceId).toBe('runner-1');

    const restarted = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-2',
    );
    expect(restarted).toMatchObject({
      outcome: 'ambiguous',
      reason: 'runner-instance-mismatch',
    });
  });

  it('rejects a different start command for an existing turn', async () => {
    await claimTurn(runtimeDir, { turnId: 'turn-1', startCommandId: 'start-1' }, 'runner-1');
    const conflict = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-2' },
      'runner-1',
    );
    expect(conflict.outcome).toBe('conflict');
    expect((await readTurnState(runtimeDir, 'turn-1'))?.startCommandId).toBe('start-1');
  });

  it('validates turn-owned image references and rejects tampering', async () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    const dir = join(runtimeDir, '.verity-sessions/attachments/turn-turn-1');
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from('original image bytes');
    const filePath = join(dir, 'image.png');
    await writeFile(filePath, bytes);
    const image = {
      kind: 'image',
      mediaType: 'image/png',
      filePath,
      byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    expect(
      validateStartTurnRequest({ ...base, attachments: [{ ...image, extra: 'x' }] }).attachments,
    ).toEqual([image]);
    expect(validateStartTurnRequest(base)).not.toHaveProperty('attachments');
    for (const override of [
      { kind: 'file' },
      { mediaType: 'image/tiff' },
      { byteSize: 0 },
      { byteSize: bytes.length + 1 },
      { sha256: '0'.repeat(64) },
      { filePath: join(dir, '../image.png') },
      { filePath: join(runtimeDir, '.verity-sessions/attachments/turn-other/image.png') },
      { filePath: join(dir, 'missing.png') },
    ]) {
      expect(() =>
        validateStartTurnRequest({ ...base, attachments: [{ ...image, ...override }] }),
      ).toThrow(/invalid attachment/u);
    }
    expect(() =>
      validateStartTurnRequest({ ...base, attachments: Array.from({ length: 9 }, () => image) }),
    ).toThrow(/invalid attachments/u);
    await symlink(filePath, join(dir, 'symlink.png'));
    expect(() =>
      validateStartTurnRequest({
        ...base,
        attachments: [{ ...image, filePath: join(dir, 'symlink.png') }],
      }),
    ).toThrow(/invalid attachment/u);
    await writeFile(filePath, Buffer.alloc(bytes.length, 42));
    expect(() => validateStartTurnRequest({ ...base, attachments: [image] })).toThrow(
      /invalid attachment/u,
    );
    await rename(dir, `${dir}-original`);
    await symlink(`${dir}-original`, dir);
    expect(() => validateStartTurnRequest({ ...base, attachments: [image] })).toThrow(
      /invalid attachment/u,
    );
  });

  it('ignores request fields it does not know', () => {
    // The rollout contract behind the two-phase start (ADR 0006 D9). The Server and
    // the Sandbox image roll independently, so a Server that has learned a new start
    // field will send it to a supervisor that has never heard of it — `startAck` is
    // the first, and this change is what introduces it. That is safe for exactly one
    // reason: this validator builds an ALLOW-LISTED result instead of refusing a
    // frame with surplus keys, so an unknown field is dropped and the start runs as
    // it did before. Turn that into a rejection and every Sandbox still on the old
    // image fails every turn the moment the Server ships — so it is pinned here,
    // where the next person to add a strict-shape check will see it.
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    const withFuture = validateStartTurnRequest({
      ...base,
      startAck: true,
      // Stand-ins for whatever the Server learns to send next.
      someFieldFromALaterServer: { nested: ['x'] },
    });
    expect(withFuture).not.toHaveProperty('startAck');
    expect(withFuture).not.toHaveProperty('someFieldFromALaterServer');
    // And the known fields survive it untouched — the unknown keys are dropped, not
    // treated as a reason to fall back to some reduced request.
    expect(withFuture).toEqual(validateStartTurnRequest(base));
  });

  it('rejects an oversize inline image instead of truncating it', () => {
    // A single image whose base64 alone exceeds the 4 MB start-request cap must be
    // rejected outright — no silent truncation. Sized just past the whole-request limit.
    const oversize = 'A'.repeat(4 * 1024 * 1024 + 1);
    expect(() =>
      validateStartTurnRequest({
        protocolVersion: 1,
        kind: 'start-turn',
        turnId: 'turn-1',
        startCommandId: 'start-1',
        sessionId: 'session-1',
        backend: 'claude-acp',
        worktree: runtimeDir,
        cwd: runtimeDir,
        prompt: 'look',
        attachments: [{ kind: 'image', mediaType: 'image/png', data: oversize }],
      }),
    ).toThrow(/exceeds supervisor limit/u);
  });

  it('validates and forwards the per-turn Verity session environment', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    expect(
      validateStartTurnRequest({
        ...base,
        sessionEnv: { VERITY_SESSION_BACKEND: 'claude', VERITY_SESSION_MODEL: 'sonnet' },
      }).sessionEnv,
    ).toEqual({ VERITY_SESSION_BACKEND: 'claude', VERITY_SESSION_MODEL: 'sonnet' });
    expect(() => validateStartTurnRequest({ ...base, sessionEnv: { PATH: '/tmp/bin' } })).toThrow(
      /invalid sessionEnv/u,
    );
    expect(() =>
      validateStartTurnRequest({ ...base, sessionEnv: { VERITY_SESSION_SECRET: 'nope' } }),
    ).toThrow(/invalid sessionEnv/u);
    expect(() =>
      validateStartTurnRequest({
        ...base,
        sessionEnv: { VERITY_SESSION_MODEL: 'x'.repeat(257) },
      }),
    ).toThrow(/invalid sessionEnv/u);
  });

  it('forwards a well-formed git author and refuses one that could forge a commit header', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    const author = { name: 'Lena Berg', email: 'lena@example.com' };
    expect(validateStartTurnRequest({ ...base, gitAuthor: author }).gitAuthor).toEqual(author);
    expect(validateStartTurnRequest(base).gitAuthor).toBeUndefined();
    for (const malformed of [
      { name: 'Lena\nAuthor: x', email: 'lena@example.com' },
      { name: 'Lena', email: 'lena@example.com> x <y@z' },
      { name: ' ', email: 'lena@example.com' },
      { name: 'Lena', email: 'not-an-address' },
      { ...author, extra: 'x' },
      'Lena <lena@example.com>',
    ])
      expect(() => validateStartTurnRequest({ ...base, gitAuthor: malformed })).toThrow(
        /invalid gitAuthor/u,
      );
    expect(validateStartTurnRequest({ ...base, signCommits: false }).signCommits).toBe(false);
    expect(validateStartTurnRequest(base).signCommits).toBeUndefined();
    for (const malformed of [true, 'false', 0])
      expect(() => validateStartTurnRequest({ ...base, signCommits: malformed })).toThrow(
        /invalid signCommits/u,
      );
  });

  it('forwards a well-formed turn badge for any backend and refuses anything else', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    const badge = 'Ab_-'.repeat(10) + 'xyz';
    expect(validateStartTurnRequest({ ...base, turnCapability: badge }).turnCapability).toBe(badge);
    expect(validateStartTurnRequest(base).turnCapability).toBeUndefined();
    for (const malformed of ['', 'short', `${badge}=`, `${badge.slice(0, 42)}/`, 42])
      expect(() => validateStartTurnRequest({ ...base, turnCapability: malformed })).toThrow(
        /invalid turnCapability/u,
      );
  });

  // ADR 0014 D1: only an ACP turn is handed a gateway bearer, and the supervisor
  // re-derives that from the backend it was asked to start rather than trusting
  // the Server to have paired the two correctly.
  it('accepts the MCP gateway bearer only on an ACP backend', () => {
    const base = {
      protocolVersion: 1,
      kind: 'start-turn',
      turnId: 'turn-1',
      startCommandId: 'start-1',
      sessionId: 'session-1',
      backend: 'claude-acp',
      worktree: runtimeDir,
      cwd: runtimeDir,
      prompt: 'look',
    };
    expect(validateStartTurnRequest({ ...base, mcpGatewayToken: 'bearer-1' }).mcpGatewayToken).toBe(
      'bearer-1',
    );
    expect(
      validateStartTurnRequest({ ...base, backend: 'codex-acp', mcpGatewayToken: 'bearer-2' })
        .mcpGatewayToken,
    ).toBe('bearer-2');
    // A turn without a bearer never gains the field.
    expect(validateStartTurnRequest(base)).not.toHaveProperty('mcpGatewayToken');
    // An empty or oversize bearer is a wiring bug, not an absent one.
    expect(() => validateStartTurnRequest({ ...base, mcpGatewayToken: '' })).toThrow(
      /invalid mcpGatewayToken/u,
    );
    expect(() => validateStartTurnRequest({ ...base, mcpGatewayToken: 'x'.repeat(513) })).toThrow(
      /invalid mcpGatewayToken/u,
    );
  });

  it('reports a pre-existing directory without state as ambiguous', async () => {
    await mkdir(join(runtimeDir, 'turns', 'turn-1'), { recursive: true, mode: 0o770 });
    const outcome = await claimTurn(
      runtimeDir,
      { turnId: 'turn-1', startCommandId: 'start-1' },
      'runner-1',
    );
    expect(outcome).toEqual({ outcome: 'ambiguous', reason: 'turn-directory-without-state' });
  });

  it('keeps corrupt turn directories visible as ambiguous', async () => {
    await claimTurn(runtimeDir, { turnId: 'turn-b', startCommandId: 'start-b' }, 'runner-1');
    await claimTurn(runtimeDir, { turnId: 'turn-a', startCommandId: 'start-a' }, 'runner-1');
    await mkdir(join(runtimeDir, 'turns', 'broken'), { mode: 0o770 });
    await writeFile(join(runtimeDir, 'turns', 'broken', 'state.json'), 'not json');
    expect(await listTurns(runtimeDir)).toEqual([
      expect.objectContaining({ turnId: 'broken', status: 'ambiguous', reason: 'invalid-state' }),
      expect.objectContaining({ turnId: 'turn-a', status: 'claimed' }),
      expect.objectContaining({ turnId: 'turn-b', status: 'claimed' }),
    ]);
  });

  // The scan reads states concurrently; each entry must still land under its own
  // turn, or a corrupt or stateless directory would borrow a neighbour's state.
  it('lists a large turn history in order with every unreadable entry kept', async () => {
    const ids = Array.from({ length: 40 }, (_, index) => `turn-${String(index).padStart(2, '0')}`);
    for (const turnId of ids)
      await claimTurn(runtimeDir, { turnId, startCommandId: `start-${turnId}` }, 'runner-1');
    await writeFile(join(runtimeDir, 'turns', 'turn-07', 'state.json'), 'not json');
    await rm(join(runtimeDir, 'turns', 'turn-23', 'state.json'));
    const turns = await listTurns(runtimeDir);
    expect(turns.map((turn) => turn.turnId)).toEqual(ids);
    expect(turns[7]).toMatchObject({ status: 'ambiguous', reason: 'invalid-state' });
    expect(turns[23]).toMatchObject({ status: 'ambiguous', reason: 'missing-state' });
    expect(turns.filter((turn) => turn.status === 'claimed')).toHaveLength(38);
  });

  it('refuses a second live singleton claim', async () => {
    const first = await acquireSingleton(runtimeDir, 'runner-1');
    await expect(acquireSingleton(runtimeDir, 'runner-2')).rejects.toThrow(/already claimed/);
    await first.release();
    const second = await acquireSingleton(runtimeDir, 'runner-2');
    expect(second.instanceId).toBe('runner-2');
    await second.release();
  });

  it('reclaims after a dead holder: the freed flock gates ownership, not the leftover owner file', async () => {
    // A crashed supervisor leaves supervisor.lock.json behind but no longer holds
    // the flock. The owner file is diagnostic only and is never consulted for
    // ownership, so a fresh process reclaims the singleton purely because the
    // kernel lock on supervisor.lock is free.
    await writeFile(join(runtimeDir, 'supervisor.lock'), '', { mode: 0o660 });
    await writeFile(
      join(runtimeDir, 'supervisor.lock.json'),
      `${JSON.stringify({ pid: 2_147_483_647, instanceId: 'dead-runner' })}\n`,
      { mode: 0o660 },
    );
    const recovered = await acquireSingleton(runtimeDir, 'runner-new');
    expect(recovered.instanceId).toBe('runner-new');
    await recovered.release();
  });

  it('treats the owner metadata as diagnostic only, even when it names this live pid', async () => {
    // Guards against anyone later reintroducing pid/start-time "trust": an owner
    // file naming the CURRENT live process must not fool the next claim into
    // believing the singleton is held. acquireSingleton reads nothing from the
    // file — it only re-acquires the (currently free) flock — so the claim
    // succeeds regardless of what the leftover metadata says.
    await writeFile(join(runtimeDir, 'supervisor.lock'), '', { mode: 0o660 });
    await writeFile(
      join(runtimeDir, 'supervisor.lock.json'),
      `${JSON.stringify({
        pid: process.pid,
        processStartTime: 'not-this-process',
        instanceId: 'old-container',
      })}\n`,
      { mode: 0o660 },
    );
    const recovered = await acquireSingleton(runtimeDir, 'new-container');
    expect(recovered.instanceId).toBe('new-container');
    await recovered.release();
  });

  it('fences a separate process through the shared runtime file lock', async () => {
    const first = await acquireSingleton(runtimeDir, 'runner-parent');
    const moduleUrl = new URL(
      '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs',
      import.meta.url,
    ).href;
    const script = `
      import { acquireSingleton } from ${JSON.stringify(moduleUrl)};
      try {
        await acquireSingleton(process.argv[1], 'runner-child');
        process.exitCode = 2;
      } catch (error) {
        if (!String(error).includes('already claimed')) throw error;
        process.stdout.write('fenced');
      }
    `;
    try {
      await expect(
        execFileAsync(process.execPath, ['--input-type=module', '--eval', script, runtimeDir]),
      ).resolves.toMatchObject({ stdout: 'fenced' });
    } finally {
      await first.release();
    }
  });

  it('atomically elects exactly one singleton under concurrent startup', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        acquireSingleton(runtimeDir, `runner-${String(index)}`),
      ),
    );
    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSingleton>>> =>
        attempt.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    expect(
      attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'),
    ).toHaveLength(11);
    await winners[0]?.value.release();
  });

  it('serves discovery and idempotent claims over the supervisor socket', async () => {
    const supervisor = await runSupervisor({ runtimeDir });
    try {
      await expect(probeSupervisor(runtimeDir)).resolves.toBe(true);
      const request = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
        await new Promise((resolve, reject) => {
          const socket = createConnection(supervisor.socketPath);
          let response = '';
          socket.once('error', reject);
          socket.on('data', (chunk) => {
            response += chunk.toString('utf8');
          });
          socket.once('end', () => resolve(JSON.parse(response) as Record<string, unknown>));
          socket.once('connect', () => {
            socket.write(`${JSON.stringify(payload)}\n`);
          });
        });

      await expect(request({ protocolVersion: 1, kind: 'status' })).resolves.toMatchObject({
        ok: true,
        runnerInstanceId: supervisor.instanceId,
      });
      await expect(
        request({
          protocolVersion: 1,
          kind: 'claim-turn',
          turnId: 'turn-socket',
          startCommandId: 'start-socket',
        }),
      ).resolves.toMatchObject({ ok: true, outcome: 'created' });
      await expect(request({ protocolVersion: 1, kind: 'list-turns' })).resolves.toMatchObject({
        ok: true,
        turns: [{ turnId: 'turn-socket' }],
      });
    } finally {
      await supervisor.close();
    }
  });
});
