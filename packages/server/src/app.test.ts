import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventBus, type Backend, type SpawnedProcess, type Spawner } from '@verity/session';
import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { ProjectRecord } from '@verity/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildControlPlane } from './app.js';
import type { GitHubTaskService } from './github-tasks.js';

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

/** A backend that answers a one-shot with `reply` and refuses to run turns.
 *
 * The refine route (ADR 0007) is exercised through this rather than through a
 * spawner: only a backend that HAS a native one-shot reaches `backend.query`,
 * and the default Claude transport deliberately has none — it routes meta
 * queries through a transient supervised turn instead (ADR 0012). What the route
 * owns is the prompt it builds and the reply it parses, which is what this pins. */
function oneShotBackend(reply: string, prompts: string[] = []): Backend {
  return {
    run: () => Promise.reject(new Error('one-shot backend runs no turns')),
    query: (input) => {
      prompts.push(input.prompt);
      return Promise.resolve(reply);
    },
  };
}

describe('buildControlPlane', () => {
  it('injects durable Verity Control capabilities for project and legacy control sessions', async () => {
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

  // Regression (#137): buildControlPlane must FORWARD the GitHub deps (`listIssues`,
  // and on the same spread path `branchPr`) to buildServer. They were declared only
  // on buildServer's deps and silently dropped here, so the embedded composition's
  // PR chip / issue list never reached the routes.
  it('forwards listIssues to the issues route (was silently dropped)', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      listIssues: () =>
        Promise.resolve([{ number: 137, title: 't', body: 'b', url: 'https://gh/137' }]),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/issues' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ number: 137, title: 't', body: 'b', url: 'https://gh/137' }]);
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

  it('503s the issues route when listIssues is not provided', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/issues' });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  // ADR 0007: like listIssues, the task service must be FORWARDED to buildServer or
  // the /tasks routes silently never see it (#137). These cover the forwarding, the
  // not-configured 503, and a write's 502-on-failure contract with a stub service.
  const stubTaskService = (over: Partial<GitHubTaskService> = {}): GitHubTaskService => ({
    getBoard: () => Promise.resolve(null),
    repositoryId: () => Promise.resolve('R_1'),
    repositoryIdFor: () => Promise.resolve('R_for'),
    createDraft: () => Promise.resolve(null),
    convertDraftToIssue: () => Promise.resolve(null),
    createIssue: () => Promise.resolve(null),
    updateIssue: () => Promise.resolve(false),
    reorder: () => Promise.resolve(false),
    removeItem: () => Promise.resolve(false),
    setField: () => Promise.resolve(false),
    ...over,
  });

  it('forwards the task service to GET /tasks and returns the board', async () => {
    const board = { projectId: 'PVT_1', number: 7, title: 'Roadmap', items: [], fields: [] };
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({ getBoard: () => Promise.resolve(board) }),
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ board });
    } finally {
      await app.close();
    }
  });

  it('503s every /tasks route when no task service is configured', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/tasks' })).statusCode).toBe(503);
      expect(
        (await app.inject({ method: 'POST', url: '/tasks/drafts', payload: { title: 't' } }))
          .statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('creates a draft (201) and 502s a write the service cannot confirm', async () => {
    const item = {
      id: 'PVTI_1',
      type: 'DRAFT_ISSUE' as const,
      number: null,
      title: 'idea',
      body: '',
      url: '',
      state: null,
      contentId: 'DI_1',
      fields: [],
    };
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({ createDraft: () => Promise.resolve(item) }),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/tasks/drafts',
        payload: { title: 'idea' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({ item });
      // reorder falls back to the stub's `false` → a 502 with an error body.
      const bad = await app.inject({
        method: 'POST',
        url: '/tasks/reorder',
        payload: { itemId: 'PVTI_1' },
      });
      expect(bad.statusCode).toBe(502);

      const removeBad = await app.inject({ method: 'DELETE', url: '/tasks/PVTI_1' });
      expect(removeBad.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('files an issue (POST /tasks/issues), converts a draft, and edits an issue', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        repositoryId: () => Promise.resolve('R_1'),
        createIssue: () => Promise.resolve({ issueId: 'I', itemId: 'PVTI', number: 5, url: 'u' }),
        convertDraftToIssue: () => Promise.resolve({ itemId: 'PVTI', number: 6, url: 'u6' }),
        updateIssue: () => Promise.resolve(true),
      }),
    });
    try {
      // repositoryId omitted → the route resolves the origin repo via the service.
      const created = await app.inject({
        method: 'POST',
        url: '/tasks/issues',
        payload: { title: 'New' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual({
        issue: { issueId: 'I', itemId: 'PVTI', number: 5, url: 'u' },
      });

      const converted = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/convert',
        payload: { repositoryId: 'R_1' },
      });
      expect(converted.statusCode).toBe(200);
      expect(converted.json()).toEqual({ result: { itemId: 'PVTI', number: 6, url: 'u6' } });

      const patched = await app.inject({
        method: 'PATCH',
        url: '/tasks/issues/I_1',
        payload: { state: 'CLOSED' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('removes a board item via DELETE /tasks/:itemId', async () => {
    let removed: string | undefined;
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        removeItem: (input) => {
          removed = input.itemId;
          return Promise.resolve(true);
        },
      }),
    });
    try {
      const res = await app.inject({ method: 'DELETE', url: '/tasks/PVTI_1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(removed).toBe('PVTI_1');
    } finally {
      await app.close();
    }
  });

  it('502s POST /tasks/issues when the repository cannot be resolved', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({ repositoryId: () => Promise.resolve(null) }),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/issues',
        payload: { title: 'x' },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it('files an issue into a chosen repo (repo picker) via a parsed owner/repo', async () => {
    let resolvedFor: { owner: string; repo: string } | undefined;
    let createdIn: string | undefined;
    let createdRepo: { owner: string; repo: string } | undefined;
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        repositoryIdFor: (input) => {
          resolvedFor = input;
          return Promise.resolve('R_widgets');
        },
        createIssue: (input) => {
          createdIn = input.repositoryId;
          createdRepo = input.repo;
          return Promise.resolve({ issueId: 'I', itemId: 'PVTI', number: 5, url: 'u' });
        },
      }),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/issues',
        payload: { title: 'New', repo: 'acme/widgets' },
      });
      expect(res.statusCode).toBe(201);
      expect(resolvedFor).toEqual({ owner: 'acme', repo: 'widgets' }); // parsed owner/repo
      expect(createdIn).toBe('R_widgets'); // filed into the resolved repo, not origin
      expect(createdRepo).toEqual({ owner: 'acme', repo: 'widgets' }); // token mint target
    } finally {
      await app.close();
    }
  });

  it('passes a chosen repo through when the client already knows the repo node id', async () => {
    let createdIn: string | undefined;
    let createdRepo: { owner: string; repo: string } | undefined;
    let convertedIn: string | undefined;
    let convertedRepo: { owner: string; repo: string } | undefined;
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        createIssue: (input) => {
          createdIn = input.repositoryId;
          createdRepo = input.repo;
          return Promise.resolve({ issueId: 'I', itemId: 'PVTI', number: 5, url: 'u' });
        },
        convertDraftToIssue: (input) => {
          convertedIn = input.repositoryId;
          convertedRepo = input.repo;
          return Promise.resolve({ itemId: input.itemId, number: 9, url: 'u9' });
        },
      }),
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/tasks/issues',
        payload: { title: 'New', repositoryId: 'R_widgets', repo: 'acme/widgets' },
      });
      expect(created.statusCode).toBe(201);
      expect(createdIn).toBe('R_widgets');
      expect(createdRepo).toEqual({ owner: 'acme', repo: 'widgets' });

      const converted = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/convert',
        payload: { repositoryId: 'R_widgets', repo: 'acme/widgets' },
      });
      expect(converted.statusCode).toBe(200);
      expect(convertedIn).toBe('R_widgets');
      expect(convertedRepo).toEqual({ owner: 'acme', repo: 'widgets' });
    } finally {
      await app.close();
    }
  });

  it('400s POST /tasks/issues when the chosen repo string is malformed', async () => {
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService(),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/issues',
        payload: { title: 'x', repo: 'not-a-valid-owner-repo/extra/segment' },
      });
      // A malformed owner/repo is a client error, not an upstream failure.
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('converts a draft into a chosen repo (repo picker) and 400s a malformed repo', async () => {
    let convertedIn: string | undefined;
    let convertedRepo: { owner: string; repo: string } | undefined;
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        repositoryIdFor: () => Promise.resolve('R_gadgets'),
        convertDraftToIssue: (input) => {
          convertedIn = input.repositoryId;
          convertedRepo = input.repo;
          return Promise.resolve({ itemId: input.itemId, number: 9, url: 'u9' });
        },
      }),
    });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/convert',
        payload: { repo: 'acme/gadgets' },
      });
      expect(ok.statusCode).toBe(200);
      expect(convertedIn).toBe('R_gadgets'); // converted into the resolved repo, not origin
      expect(convertedRepo).toEqual({ owner: 'acme', repo: 'gadgets' }); // token mint target

      const bad = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/convert',
        payload: { repo: 'not/a/valid/repo' },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('sets a field via POST /tasks/:itemId/field (and 502s an unknown field/option)', async () => {
    const calls: { itemId: string; field: string; option: string }[] = [];
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
      taskService: stubTaskService({
        setField: (input) => {
          calls.push(input);
          return Promise.resolve(input.option === 'P1'); // only a valid option "succeeds"
        },
      }),
    });
    try {
      const ok = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/field',
        payload: { field: 'Priority', value: 'P1' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ ok: true });
      expect(calls[0]).toEqual({ itemId: 'PVTI_1', field: 'Priority', option: 'P1' });

      const bad = await app.inject({
        method: 'POST',
        url: '/tasks/PVTI_1/field',
        payload: { field: 'Priority', value: 'Nope' },
      });
      expect(bad.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  // Voice → Refiner (ADR 0007): POST /tasks/refine runs the conductor's one-shot query
  // (driven here by the fake spawner producing `claude -p` stdout) and parses the JSON.
  it('refines a transcript into a blueprint via the one-shot query', async () => {
    const blueprint = {
      title: 'Add dark mode',
      problem: 'Users want a dark theme.',
      acceptanceCriteria: ['Toggle in settings'],
      affectedAreas: [],
      openQuestions: [],
    };
    const prompts: string[] = [];
    const app = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {
        backend: oneShotBackend(JSON.stringify(blueprint), prompts),
      },
      refineCwd: process.cwd(),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/refine',
        payload: { transcript: 'we should add a dark mode' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ refined: blueprint });
      expect(prompts[0]).toContain('we should add a dark mode');
    } finally {
      await app.close();
    }
  });

  it('503s /tasks/refine without a refine cwd, and 502s an unparseable reply', async () => {
    const off = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { spawner: () => fakeProcess([initLine, resultLine]) },
    });
    try {
      const res = await off.inject({
        method: 'POST',
        url: '/tasks/refine',
        payload: { transcript: 'x' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await off.close();
    }

    const garbled = buildControlPlane({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: { backend: oneShotBackend('sorry, I cannot help with that') },
      refineCwd: process.cwd(),
    });
    try {
      const res = await garbled.inject({
        method: 'POST',
        url: '/tasks/refine',
        payload: { transcript: 'x' },
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await garbled.close();
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
