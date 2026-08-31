import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpCodexBackend } from './acp-codex-backend.js';
import { GATEWAY_UNAVAILABLE_DIRECTIVE } from './acp-backend.js';
import type { SpawnedProcess, Spawner } from './backend-contract.js';

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

/** The `model` select codex-acp answers `session/new` with: bare base model ids,
 *  with the reasoning effort carried by a SEPARATE option. */
const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'gpt-5.1-codex',
  options: [
    { id: 'gpt-5.1-codex', name: 'gpt-5.1-codex', value: 'gpt-5.1-codex' },
    { id: 'gpt-5.2-codex', name: 'gpt-5.2-codex', value: 'gpt-5.2-codex' },
  ],
};

function acpSpawner(
  behavior: {
    loadSession?: boolean;
    /** Refuse `session/load` the way the adapter refuses a rollout it cannot
     *  restore: JSON-RPC -32002 naming the requested id. */
    loadNotFound?: boolean;
    /** Answer `session/new` without the `model` config option, as an adapter
     *  build that does not expose it would. */
    withoutModelOption?: boolean;
    /** The mode `session/new` reports the session already opened in. */
    modeId?: string;
    /** Answer `session/set_config_option` with the full option set, but with the
     *  model still on the one the session opened with. */
    echoStaleModel?: boolean;
    /** Advertise HTTP MCP support in the adapter's initialize response. */
    httpMcp?: boolean;
    cancel?: { operator?: AbortController };
  } = {},
): {
  spawner: Spawner;
  writes: Record<string, unknown>[];
  kill: ReturnType<typeof vi.fn>;
} {
  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let closed = false;
  const push = (message: unknown): void => {
    const value = `${JSON.stringify(message)}\n`;
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter({ value, done: false });
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  };
  const kill = vi.fn(close);
  const writes: Record<string, unknown>[] = [];
  const stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<string>> => {
          const value = queue.shift();
          if (value !== undefined) return { value, done: false };
          if (closed) return { value: undefined, done: true };
          return await new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
  const sessionResult = (sessionId: string): Record<string, unknown> => ({
    sessionId,
    modes: {
      currentModeId: behavior.modeId ?? 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read Only' },
        { id: 'agent', name: 'Agent' },
        { id: 'agent-full-access', name: 'Full Access' },
      ],
    },
    ...(behavior.withoutModelOption === true ? {} : { configOptions: [MODEL_OPTION] }),
  });
  const spawner: Spawner = (command, _args, options): SpawnedProcess => {
    expect(command).toBe('codex-acp');
    expect(options.keepStdinOpen).toBe(true);
    return {
      stdout,
      pid: 321,
      exited: Promise.resolve(0),
      stderr: () => '',
      kill,
      closeStdin: close,
      writeStdin(data) {
        for (const line of data.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as Record<string, unknown>;
          writes.push(message);
          const id = message['id'];
          const method = message['method'];
          if (method === 'initialize') {
            push({
              jsonrpc: '2.0',
              id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  loadSession: behavior.loadSession !== false,
                  ...(behavior.httpMcp === true
                    ? { mcpCapabilities: { http: true, sse: false } }
                    : {}),
                },
              },
            });
          } else if (method === 'session/new') {
            push({ jsonrpc: '2.0', id, result: sessionResult('codex-session-1') });
          } else if (method === 'session/load' && behavior.loadNotFound === true) {
            push({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32002,
                message: 'Resource not found: codex-session-existing',
                data: { uri: 'codex-session-existing' },
              },
            });
          } else if (method === 'session/load') {
            push({ jsonrpc: '2.0', id, result: sessionResult('codex-session-existing') });
          } else if (method === 'session/set_mode' || method === 'session/set_config_option') {
            // Echoing nothing is the adapter shape Codex actually has today, and it
            // keeps the plain ack's meaning in `applySelectOption`. `echoStaleModel`
            // is the other half of that contract — an adapter that answers with the
            // full option set and shows the write did not land.
            push({
              jsonrpc: '2.0',
              id,
              result:
                behavior.echoStaleModel === true && method === 'session/set_config_option'
                  ? sessionResult('codex-session-1')
                  : {},
            });
          } else if (method === 'session/prompt' && behavior.cancel !== undefined) {
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'codex-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Working…' },
                },
              },
            });
            behavior.cancel.operator?.abort();
            push({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          } else if (method === 'session/prompt') {
            // codex-acp sets no tool `name` — only ACP's `kind` and a `title`
            // that for a command execution IS the command line.
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'codex-session-1',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'call_1',
                  status: 'in_progress',
                  kind: 'execute',
                  title: 'ls -la',
                  rawInput: { command: 'ls -la' },
                },
              },
            });
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'codex-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Done.' },
                },
              },
            });
            push({
              jsonrpc: '2.0',
              id,
              result: {
                stopReason: 'end_turn',
                usage: { totalTokens: 7, inputTokens: 4, outputTokens: 3 },
              },
            });
          }
        }
        return true;
      },
    };
  };
  return { spawner, writes, kill };
}

function write(
  writes: Record<string, unknown>[],
  method: string,
): Record<string, unknown> | undefined {
  return writes.find((message) => message['method'] === method);
}

describe('AcpCodexBackend', () => {
  it('runs a Codex turn through ACP, carrying the system directives in the prompt', async () => {
    const fake = acpSpawner();
    let steer: ((message: { text: string }) => boolean) | undefined;
    const running = new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-1',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      appendSystemPrompt: 'Verity runtime policy',
      spawner: fake.spawner,
      onSteer: (inject) => {
        steer = inject;
      },
    });
    // Not steerable before the turn has produced agent content — the shared
    // `runAcpTurn` gate (see the Claude ACP backend's steering test). The
    // Conductor queues the message as its own turn instead.
    expect(steer?.({ text: 'change direction' })).toBe(false);
    const result = await running;
    expect(result).toMatchObject({ sessionId: 'codex-session-1', exitCode: 0, aborted: false });
    // Codex has no system-prompt channel — neither exec nor ACP — so the
    // directives ride in front of the turn's own prompt text.
    expect(write(fake.writes, 'session/prompt')).toMatchObject({
      params: {
        sessionId: 'codex-session-1',
        prompt: [{ type: 'text', text: 'Verity runtime policy\n\nDo it' }],
      },
    });
    const initialize = write(fake.writes, 'initialize');
    expect(initialize).not.toHaveProperty('params.clientCapabilities.fs');
    expect(initialize).not.toHaveProperty('params.clientCapabilities.terminal');
    // Claude's `claudeCode` session options must not leak into the Codex adapter.
    expect(write(fake.writes, 'session/new')).toMatchObject({
      params: { cwd: '/work/project', mcpServers: [] },
    });
    expect(write(fake.writes, 'session/new')).not.toHaveProperty('params._meta.claudeCode');
    expect((await ctx.store.getEvents('verity-codex-1')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'tool_call_start',
      'tool_call',
      'text',
      'result',
      'status',
    ]);
    expect(fake.kill).toHaveBeenCalled();
    expect(fake.writes.some((message) => message['method'] === '_session/steering')).toBe(false);
  });

  it('offers the turn gateway when Codex advertises HTTP MCP', async () => {
    const url = 'http://relay:8080/internal/mcp';
    const fake = acpSpawner({ httpMcp: true });
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-mcp',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Use Verity tools',
      spawner: fake.spawner,
      mcpGateway: { url, token: 'codex-turn-bearer' },
    });
    expect(write(fake.writes, 'session/new')).toMatchObject({
      params: {
        mcpServers: [
          {
            type: 'http',
            name: 'verity',
            url,
            headers: [{ name: 'Authorization', value: 'Bearer codex-turn-bearer' }],
          },
        ],
      },
    });
  });

  it('withholds the gateway bearer when Codex does not advertise HTTP MCP', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-no-mcp',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'unused-turn-bearer' },
    });
    expect(write(fake.writes, 'session/new')).toMatchObject({ params: { mcpServers: [] } });
    expect(JSON.stringify(fake.writes)).not.toContain('unused-turn-bearer');
  });

  it('tells a Codex turn when it was entitled to the gateway and did not get it', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-no-mcp-notice',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'unused-turn-bearer' },
    });
    const prompt = write(fake.writes, 'session/prompt') as
      { params?: { prompt?: { type: string; text?: string }[] } } | undefined;
    const text = prompt?.params?.prompt?.[0]?.text ?? '';
    expect(text).toContain(GATEWAY_UNAVAILABLE_DIRECTIVE);
    expect(text).toContain('Do it');
    expect(JSON.stringify(fake.writes)).not.toContain('unused-turn-bearer');
  });

  it('names a tool call by its ACP kind, not by the command line codex-acp puts in the title', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-2',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Without the kind→name map every command would be titled with its own
    // command line, which the transcript renders as the tool's name.
    expect(
      (await ctx.store.getEvents('verity-codex-2')).filter((event) => event.t === 'tool_call'),
    ).toEqual([expect.objectContaining({ t: 'tool_call', id: 'call_1', name: 'Bash' })]);
  });

  it('uses the full-access posture inside the project sandbox', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-3',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Codex runs with `approvalPolicy: 'never'` + `sandbox: 'danger-full-access'`
    // natively: the project container is the isolation boundary and there is no
    // Codex approval UI, so a second permission layer would only diverge.
    expect(write(fake.writes, 'session/set_mode')).toMatchObject({
      params: { sessionId: 'codex-session-1', modeId: 'agent-full-access' },
    });
  });

  it('pins that posture itself and never lets a caller-supplied permission mode reach it', async () => {
    // The §5b seam in `acp-backend.ts` checks `opts.permissionMode` against the
    // PROFILE's `permissionModes`, and this profile declares none — which is only
    // safe because it ignores the option and returns a constant, so no caller value
    // ever becomes the session's mode. Pinned here: if the Codex profile ever starts
    // honoring `opts.permissionMode`, this fails and the vocabulary has to be
    // declared alongside that change instead of the hole opening silently.
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-mode-pinned',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      permissionMode: 'danger-full-access',
      spawner: fake.spawner,
    });
    expect(write(fake.writes, 'session/set_mode')).toMatchObject({
      params: { modeId: 'agent-full-access' },
    });
  });

  it('asserts the posture after model selection, not on the mode session/new reported', async () => {
    const fake = acpSpawner({ modeId: 'agent-full-access' });
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-4',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'codex/gpt-5.2-codex',
      spawner: fake.spawner,
    });
    // Selecting a model can clamp the session into a mode that model supports,
    // so the posture reported at session/new is not evidence of the posture the
    // prompt will run in. Assert it afterwards even when the adapter opened the
    // session in it already.
    const order = (method: string): number =>
      fake.writes.findIndex((message) => message['method'] === method);
    expect(order('session/set_config_option')).toBeGreaterThanOrEqual(0);
    expect(order('session/set_mode')).toBeGreaterThan(order('session/set_config_option'));
    expect(order('session/prompt')).toBeGreaterThan(order('session/set_mode'));
    expect(write(fake.writes, 'session/set_mode')).toMatchObject({
      params: { sessionId: 'codex-session-1', modeId: 'agent-full-access' },
    });
  });

  it('selects the requested model through the standard session config option', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-5',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'codex/gpt-5.2-codex',
      spawner: fake.spawner,
    });
    // The reasoning effort is a separate option, so setting the model here never
    // resets the session's effort.
    expect(write(fake.writes, 'session/set_config_option')).toMatchObject({
      params: { sessionId: 'codex-session-1', configId: 'model', value: 'gpt-5.2-codex' },
    });
  });

  it('keeps the session model and notices when the requested one is unavailable', async () => {
    const fake = acpSpawner();
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-6',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'codex/gpt-9-codex',
      spawner: fake.spawner,
    });
    // Verity's model catalogue refreshes on its own schedule and can legitimately
    // run ahead of what this account serves — not worth failing a turn over.
    expect(result.exitCode).toBe(0);
    expect(write(fake.writes, 'session/set_config_option')).toBeUndefined();
    const notice = (await ctx.store.getEvents('verity-codex-6')).find((e) => e.t === 'notice');
    // The requested model and the one that actually runs. The `session` event records
    // the former, so the latter is only ever visible here.
    expect(notice).toMatchObject({ t: 'notice', text: expect.stringContaining('gpt-9-codex') });
    expect(notice).toMatchObject({ t: 'notice', text: expect.stringContaining('gpt-5.1-codex') });
  });

  it('says so when the adapter takes the model write and reports another model', async () => {
    const fake = acpSpawner({ echoStaleModel: true });
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-6b',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      // Offered by the session, so the write goes out and is answered without an
      // error — and the options that come back with the answer still read
      // `gpt-5.1-codex`. For a model that is a preference, not a posture, so the turn
      // runs; what it must not do is leave the transcript claiming a model it never used.
      model: 'codex/gpt-5.2-codex',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    const notice = (await ctx.store.getEvents('verity-codex-6b')).find((e) => e.t === 'notice');
    expect(notice).toMatchObject({
      t: 'notice',
      // Not "unavailable" — the session offered this model and then did not switch to
      // it, which is a different fact about a different party.
      text: 'Codex model "gpt-5.2-codex" was not applied; this turn runs on "gpt-5.1-codex".',
    });
  });

  it('does not set a model on an adapter build that exposes no model option', async () => {
    const fake = acpSpawner({ withoutModelOption: true });
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-7',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'codex/gpt-5.2-codex',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    expect(write(fake.writes, 'session/set_config_option')).toBeUndefined();
  });

  it('sends an image attachment inline instead of materializing a broker file', async () => {
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-8',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Look',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      spawner: fake.spawner,
    });
    // codex-acp advertises `promptCapabilities.image`, so the whole broker file
    // materialization path the native transport needs simply does not apply.
    expect(write(fake.writes, 'session/prompt')).toMatchObject({
      params: {
        prompt: [
          { type: 'text', text: 'Look' },
          { type: 'image', mimeType: 'image/png', data: 'aGk=' },
        ],
      },
    });
  });

  it('resumes a persisted Codex conversation through session/load', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-codex-9',
      worktree: '/work/project',
      model: 'codex/default',
    });
    const fake = acpSpawner({ httpMcp: true });
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-9',
      resumeSessionId: 'codex-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
      mcpGateway: {
        url: 'http://relay:8080/internal/mcp',
        token: 'resumed-turn-bearer',
      },
    });
    expect(result.sessionId).toBe('codex-session-existing');
    expect(write(fake.writes, 'session/load')).toMatchObject({
      params: {
        mcpServers: [
          {
            type: 'http',
            name: 'verity',
            url: 'http://relay:8080/internal/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer resumed-turn-bearer' }],
          },
        ],
      },
    });
    expect(write(fake.writes, 'session/new')).toBeUndefined();
  });

  it('reports no bind when the adapter refuses to load the resumed conversation', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-codex-10',
      worktree: '/work/project',
      model: 'codex/default',
    });
    const fake = acpSpawner({ loadNotFound: true });
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-10',
      resumeSessionId: 'codex-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // Echoing the attempted id back would let the conductor write it as the
    // session's bind, so the next turn resumes the same refused conversation and
    // fails identically — the session wedges instead of recovering cold.
    expect(result).toMatchObject({ sessionId: undefined, exitCode: 1 });
    expect(result.stderr).toContain('Resource not found: codex-session-existing');
  });

  it('settles an operator cancel without badging the session crashed', async () => {
    const controller = new AbortController();
    const fake = acpSpawner({ cancel: { operator: controller } });
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-11',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ exitCode: 0, aborted: true });
    expect((await ctx.store.getEvents('verity-codex-11')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'result',
    ]);
  });
});
