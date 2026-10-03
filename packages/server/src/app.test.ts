import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { Server as HttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Backend, type SpawnedProcess, type Spawner } from '@verity/session';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectRecord } from '@verity/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildControlPlane } from './app.js';
import { createAuthTokenRegistry } from './auth.js';
import { createProjectEgressCa, issueGatewayServerCertificate } from './claude-egress-ca.js';

let ctx: TestDb;

// Isolated (single-connection pglite), not the shared PostgreSQL harness: these
// tests fire turns and never await their ingest — `app.close()` shuts the route
// layer down, not the detached stdout pump — so a turn started in one test is
// still writing while the next one runs. `initLine` carries session `s1`, so
// that late write re-creates the very row `beforeEach` just truncated.
// On one serialized connection the stray write is issued before the TRUNCATE and
// therefore lands before it; on a pool the TRUNCATE overtakes it on another
// connection, which surfaced as a duplicate `sessions_pkey` and as TRUNCATE
// deadlocking against the ingest's own reads. Sharing here needs the turns
// drained per test, which the control plane exposes no hook for.
beforeAll(async () => {
  ctx = await createIsolatedTestDb();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await truncateAll(ctx.db);
});

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' });
const resultLine = JSON.stringify({ type: 'result', stop_reason: 'end_turn', usage: {} });
// A line with no session init → ingest throws ("no session init") in the background.
const orphanLine = JSON.stringify({
  type: 'assistant',
  message: { id: 'a', content: [{ type: 'text', text: 'x' }] },
});

function fakeProcess(lines: string[]): SpawnedProcess {
  async function* stdout(): AsyncGenerator<string> {
    for (const line of lines) yield `${line}\n`;
  }
  return {
    stdout: stdout(),
    pid: 1,
    exited: Promise.resolve(0),
    stderr: () => '',
    kill: () => undefined,
  };
}

describe('buildControlPlane', () => {
  it('serves live Uplink diagnostics through the composed control plane', async () => {
    const registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    const device = await registry.mint('iPhone');
    const diagnostics = {
      control: 'connected' as const,
      sharing: 'ready' as const,
      remoteControl: 'ready' as const,
      // Core's per-stream counters ride along; the phone shows them beside its own.
      remoteStreams: [
        {
          sessionId: 'session_one',
          streamId: 'abcdef01',
          startedAt: 1_700_000_000_000,
          durationMs: 31_000,
          firstLocalReplyMs: 53,
          receivedFromAppBytes: 1_911,
          writtenToLocalBytes: 1_911,
          receivedFromLocalBytes: 3_080,
          sentToUplinkBytes: 3_080,
          framesFromApp: 2,
          framesToApp: 3,
          state: 'open',
        },
      ],
    };
    // The route alone can pass while composition silently reports Uplink disabled.
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      authRegistry: registry,
      uplinkDiagnostics: () => diagnostics,
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/uplink/diagnostics',
        headers: { authorization: `Bearer ${device.token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(diagnostics);
    } finally {
      await app.close();
    }
  });

  it('reports public previews when the forwarded Uplink manager is available', async () => {
    const previewShareManager = {
      isAvailable: vi.fn(() => true),
    } as unknown as NonNullable<Parameters<typeof buildControlPlane>[0]['previewShareManager']>;
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      previewShareManager,
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      expect(response.json().publicPreviewsEnabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('preserves TLS through the control-plane composition boundary', async () => {
    const ca = await createProjectEgressCa({ validityDays: 1 });
    const certificate = await issueGatewayServerCertificate(ca, {
      serverName: 'localhost',
      validityDays: 1,
    });
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      https: { key: certificate.keyPem, cert: certificate.certPem },
    });
    try {
      expect(app.server).toBeInstanceOf(HttpsServer);
    } finally {
      await app.close();
    }
  });

  it('injects durable Verity Control capabilities for project and legacy Concierge sessions', async () => {
    const projectWorktree = mkdtempSync(join(tmpdir(), 'verity-project-control-'));
    const legacyWorktree = mkdtempSync(join(tmpdir(), 'verity-legacy-control-'));
    await ctx.store.upsertProject({
      id: 'verity-control',
      owner: 'verity',
      repo: 'control',
      containerName: 'verity-control',
      state: 'active',
    });
    await ctx.store.createSession({
      sessionId: 'project-control',
      worktree: projectWorktree,
      model: 'm',
      projectId: 'verity-control',
    });
    await ctx.store.createSession({
      sessionId: 'legacy-control',
      worktree: legacyWorktree,
      model: 'm',
      name: 'Concierge',
    });
    const prompts: string[] = [];
    let thread = 0;
    const backend: Backend = {
      run: async (opts) => {
        prompts.push(opts.appendSystemPrompt ?? '');
        thread += 1;
        await opts.onSession?.(`control-thread-${thread}`);
        return {
          sessionId: `control-thread-${thread}`,
          exitCode: 0,
          stderr: '',
          aborted: false,
        };
      },
    };
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { backend },
      logger: false,
    });
    try {
      for (const sessionId of ['project-control', 'legacy-control']) {
        const res = await app.inject({
          method: 'POST',
          url: `/sessions/${sessionId}/turns`,
          payload: { prompt: 'help me' },
        });
        expect(res.statusCode).toBe(202);
      }
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(prompts[0]).toContain('# Verity Control capabilities');
      expect(prompts[1]).toContain('# Verity Control capabilities');
    } finally {
      await app.close();
      rmSync(projectWorktree, { recursive: true, force: true });
      rmSync(legacyWorktree, { recursive: true, force: true });
    }
  });

  it('routes a background turn failure to the extra onTurnError sink', async () => {
    // A real existing dir so the conductor's worktree pre-flight passes and the
    // turn is accepted (202); the failure under test happens in the background.
    await ctx.store.createSession({ sessionId: 's1', worktree: process.cwd(), model: 'm' });
    const errors: { id: string; msg: string }[] = [];
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      // A backend that rejects, rather than an agent stream malformed into a
      // parse error: what this sink is for is ANY background turn rejection, and
      // since the native transport went away (ADR 0012) the specific shape of a
      // broken stream is the ACP transport's business, not the sink's.
      conductor: { backend: { run: () => Promise.reject(new Error('backend exploded')) } },
      onTurnError: (id, err) => errors.push({ id, msg: err.message }),
      logger: false,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/s1/turns',
        payload: { prompt: 'go' },
      });
      expect(res.statusCode).toBe(202); // accepted; the failure is in the background
      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });
      expect(errors[0]).toMatchObject({ id: 's1' });
      expect(errors[0]?.msg).toMatch(/backend exploded/);
    } finally {
      await app.close();
    }
  });

  it('without an extra sink, still logs and releases the lock (default sink)', async () => {
    // A real existing dir so the conductor's worktree pre-flight passes and the
    // turn is accepted (202); the failure under test happens in the background.
    await ctx.store.createSession({ sessionId: 's1', worktree: process.cwd(), model: 'm' });
    // First dispatch fails in the background (no init); the next one succeeds.
    let calls = 0;
    const spawner: Spawner = () => {
      calls += 1;
      return calls === 1 ? fakeProcess([orphanLine]) : fakeProcess([initLine, resultLine]);
    };
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner },
      // no onTurnError → the default (log-only) sink handles the failure
    });
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/sessions/s1/turns',
        payload: { prompt: 'one' },
      });
      expect(first.statusCode).toBe(202);
      // Once the failed background turn settles, its lock is released — proven by
      // a follow-up turn eventually being accepted (202) rather than 409.
      await vi.waitFor(async () => {
        const next = await app.inject({
          method: 'POST',
          url: '/sessions/s1/turns',
          payload: { prompt: 'two' },
        });
        expect(next.statusCode).toBe(202);
      });
    } finally {
      await app.close();
    }
  });

  it('forwards compact pullRequest status to the branches route', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: process.cwd(), model: 'm' });
    const pullRequest = {
      number: 119,
      title: 'Footer PR strip',
      url: 'https://github.com/heey-global/verity/pull/119',
      phase: 'open' as const,
      pipeline: 'running' as const,
      checks: { completed: 2, total: 3, successful: 2, failed: 0, pending: 1 },
      mergeable: false,
    };
    const branchPrStatus = vi
      .fn<(branch: string, worktree: string) => Promise<typeof pullRequest | null>>()
      .mockResolvedValue(pullRequest);
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      branches: {
        current: async () => 'feat/119-footer',
        sessionBranches: async () => ['feat/119-footer'],
        switchable: async () => [],
        previewable: async () => [],
        isDirty: async () => false,
        hasProjectChanges: async () => false,
        switch: async () => 'feat/119-footer',
        autoRename: async () => null,
        resetToMergedBase: async () => ({ base: 'main' }),
        mergeIntoLocalBase: async () => ({
          base: 'main',
          branch: 'feat/x',
          mergedTip: 'abc1234',
          baseTip: 'merge123',
        }),
        resetToLocalBase: async () => ({ base: 'main' }),
      },
      branchPrStatus,
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/s1/branches' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ currentPr: 119, pullRequest });
      expect(branchPrStatus).toHaveBeenCalledWith('feat/119-footer', process.cwd());
    } finally {
      await app.close();
    }
  });

  it('reports missing session workspaces on the branches route without git calls', async () => {
    await ctx.store.createSession({
      sessionId: 's1',
      worktree: '/tmp/verity-missing-worktree-x',
      model: 'm',
    });
    const current = vi.fn<() => Promise<string>>().mockResolvedValue('feat/live');
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      branches: {
        current,
        sessionBranches: async () => ['feat/live'],
        switchable: async () => [],
        previewable: async () => [],
        isDirty: async () => false,
        hasProjectChanges: async () => false,
        switch: async () => 'feat/live',
        autoRename: async () => null,
        resetToMergedBase: async () => ({ base: 'main' }),
        mergeIntoLocalBase: async () => ({
          base: 'main',
          branch: 'feat/x',
          mergedTip: 'abc1234',
          baseTip: 'merge123',
        }),
        resetToLocalBase: async () => ({ base: 'main' }),
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/sessions/s1/branches' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        current: '',
        switchable: [],
        previewable: [],
        workspaceMissing: true,
        currentPr: null,
        pullRequest: null,
      });
      expect(current).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('forwards mergePr to the pull-request merge route', async () => {
    await ctx.store.createSession({ sessionId: 's1', worktree: process.cwd(), model: 'm' });
    const mergePr = vi
      .fn<(number: number, worktree: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      mergePr,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/s1/pull-request/merge',
        payload: { number: 119 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ merged: true });
      expect(mergePr).toHaveBeenCalledWith(119, process.cwd());
    } finally {
      await app.close();
    }
  });

  it('forwards projectCloneRoot to the first turn of a project-backed session (#174)', async () => {
    await ctx.store.upsertProject({
      id: 'p1',
      owner: 'heey-global',
      repo: 'verity',
      containerName: 'dev-heey-global-verity',
      state: 'active',
    });
    const cloneRoot = mkdtempSync(join(tmpdir(), 'verity-projects-'));
    const clonePath = join(cloneRoot, 'heey-global-verity');
    mkdirSync(clonePath);
    const spawnCwds: string[] = [];
    const spawner: Spawner = (_cmd, _args, opts) => {
      spawnCwds.push(opts.cwd);
      return fakeProcess([initLine, resultLine]);
    };
    const projectBackend = vi.fn((_project: ProjectRecord, selected: Backend) => selected);
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner },
      provisioner: {
        provision: async (projectId: string): Promise<ProjectRecord> => {
          const project = await ctx.store.getProject(projectId);
          if (!project) throw new Error('missing project');
          return project;
        },
      },
      projectCloneRoot: cloneRoot,
      projectBackend,
      projectWorktrees: () => ({
        add: async () => clonePath,
        remove: async () => undefined,
      }),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions',
        payload: { prompt: 'go', project: 'heey-global/verity' },
      });
      expect(res.statusCode).toBe(201);
      const { sessionId }: { sessionId: string } = res.json();
      expect((await ctx.store.getSession(sessionId))?.worktree).toBe(clonePath);
      const turn = await app.inject({
        method: 'POST',
        url: `/sessions/${encodeURIComponent(sessionId)}/turns`,
        payload: { prompt: 'go' },
      });
      expect(turn.statusCode).toBe(202);
      expect(projectBackend).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'p1' }),
        expect.anything(),
        undefined,
      );
      expect(spawnCwds[0]).toBe(clonePath);
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true });
      await app.close();
    }
  });

  it('forwards the meeting transcriber to the server route', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'verity-meeting-control-plane-'));
    await ctx.store.createSession({ sessionId: 's1', worktree, model: 'm' });
    const meetingTranscriber = {
      transcribe: vi.fn().mockResolvedValue({
        segments: [{ speaker: 'Speaker 1', text: 'Local transcript' }],
      }),
    };
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      meetingTranscriber,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/sessions/s1/meetings/transcripts',
        payload: {
          fileName: 'meeting.mp3',
          mediaType: 'audio/mpeg',
          data: Buffer.from('audio').toString('base64'),
        },
      });
      expect(res.statusCode).toBe(200);
      expect(meetingTranscriber.transcribe).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
