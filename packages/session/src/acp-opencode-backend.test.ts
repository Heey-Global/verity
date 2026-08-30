import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpOpenCodeBackend, openCodeMode } from './acp-opencode-backend.js';
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

/** The `model` select `opencode acp` answers `session/new` with: provider-qualified
 *  ids, exactly the spelling Verity's picker uses, so no translation is needed. */
const MODEL_OPTION = {
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: 'opencode/big-pickle',
  options: [
    { id: 'opencode/big-pickle', name: 'Big Pickle', value: 'opencode/big-pickle' },
    { id: 'deepinfra/zai-org/GLM-5.2', name: 'GLM 5.2', value: 'deepinfra/zai-org/GLM-5.2' },
  ],
};

/** OpenCode's session mode is a config option too — it advertises NO ACP `modes`
 *  block, which is what keeps `session/set_mode` off this backend's path. */
const MODE_OPTION = {
  id: 'mode',
  name: 'Mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { id: 'build', name: 'Build', value: 'build' },
    { id: 'plan', name: 'Plan', value: 'plan' },
  ],
};

function acpSpawner(
  behavior: {
    loadSession?: boolean;
    /** Refuse `session/load` with JSON-RPC -32002 naming the requested id. */
    loadNotFound?: boolean;
    /** Die on `session/load` without answering it — a transport failure, not a
     *  refusal, so the conversation's fate is unknown. */
    loadCrash?: boolean;
    /** Answer `session/load` with `authRequired` — a refusal about the agent's
     *  current condition, not about whether the conversation exists. */
    loadAuthRequired?: boolean;
    /** Answer `session/new` without the `model` config option. */
    withoutModelOption?: boolean;
    /** Answer `session/new` without the `mode` config option. */
    withoutModeOption?: boolean;
    /** Offer the `mode` option, but with `build` as its only value. */
    modeWithoutPlan?: boolean;
    /** Answer `session/set_config_option` the way the live agent does — with the
     *  full option set — but with the mode still reading `build`. An ack that says
     *  the write landed and an echo that says it did not. */
    echoStaleMode?: boolean;
    /** Advertise HTTP MCP support in the agent's initialize response. */
    httpMcp?: boolean;
    /** Raise `session/request_permission` for the tool call, and hold the prompt
     *  open until the client answers it. */
    permission?: boolean;
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
    // No `modes` key at all — the measured shape of a live `opencode acp` answer.
    configOptions: [
      ...(behavior.withoutModelOption === true ? [] : [MODEL_OPTION]),
      ...(behavior.withoutModeOption === true
        ? []
        : [
            behavior.modeWithoutPlan === true
              ? { ...MODE_OPTION, options: MODE_OPTION.options.filter((o) => o.value !== 'plan') }
              : MODE_OPTION,
          ]),
    ],
  });
  /** The `session/prompt` id, held open while a permission request is outstanding. */
  let pendingPromptId: unknown;
  const spawner: Spawner = (command, args, options): SpawnedProcess => {
    expect(command).toBe('opencode-acp');
    // Empty argv is a production requirement, not an incidental of this profile: the
    // spawn broker refuses `opencode-acp` with ANY arguments, because `opencode acp`
    // accepts `--cwd` and argv would walk past the broker's worktree check
    // (`validateSpawnRequest` in verity-agent-spawn-broker.mjs). A profile that
    // started passing a flag would die at the broker on every turn in production
    // while a fake that ignored argv kept this suite green.
    expect(args).toEqual([]);
    expect(options.keepStdinOpen).toBe(true);
    return {
      stdout,
      pid: 654,
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
                  promptCapabilities: { embeddedContext: true, image: true },
                  ...(behavior.httpMcp === true
                    ? { mcpCapabilities: { http: true, sse: true } }
                    : {}),
                },
              },
            });
          } else if (method === 'session/new') {
            push({ jsonrpc: '2.0', id, result: sessionResult('opencode-session-1') });
          } else if (method === 'session/load' && behavior.loadCrash === true) {
            close();
          } else if (method === 'session/load' && behavior.loadAuthRequired === true) {
            push({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'Authentication required' },
            });
          } else if (method === 'session/load' && behavior.loadNotFound === true) {
            push({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32002,
                message: 'Resource not found: opencode-session-existing',
                data: { uri: 'opencode-session-existing' },
              },
            });
          } else if (method === 'session/load') {
            push({ jsonrpc: '2.0', id, result: sessionResult('opencode-session-existing') });
          } else if (method === 'session/set_config_option') {
            const params = message.params as { configId: string; value: string };
            const applied = sessionResult('opencode-session-1');
            applied.configOptions = (applied.configOptions as Array<Record<string, unknown>>).map(
              (option) =>
                option.id === params.configId ? { ...option, currentValue: params.value } : option,
            );
            push({
              jsonrpc: '2.0',
              id,
              result:
                behavior.echoStaleMode === true ? sessionResult('opencode-session-1') : applied,
            });
          } else if (method === undefined && 'result' in message && id === 'permission-1') {
            // The client's answer. Only now does the prompt finish, which is what
            // makes the assertion "the tool never ran unapproved" mean anything.
            push({
              jsonrpc: '2.0',
              id: pendingPromptId,
              result: { stopReason: 'end_turn' },
            });
          } else if (method === 'session/prompt' && behavior.permission === true) {
            pendingPromptId = id;
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'opencode-session-1',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'call_perm',
                  status: 'pending',
                  kind: 'execute',
                  title: 'rm -rf build',
                  rawInput: { command: 'rm -rf build' },
                },
              },
            });
            push({
              jsonrpc: '2.0',
              id: 'permission-1',
              method: 'session/request_permission',
              params: {
                sessionId: 'opencode-session-1',
                // No `_meta`, and no tool `name` — the same shape the tool_call
                // updates have, so the card's title has only `kind` to go on.
                toolCall: {
                  toolCallId: 'call_perm',
                  kind: 'execute',
                  title: 'rm -rf build',
                  rawInput: { command: 'rm -rf build' },
                },
                options: [
                  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ],
              },
            });
          } else if (method === 'session/prompt' && behavior.cancel !== undefined) {
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'opencode-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Working…' },
                },
              },
            });
            behavior.cancel.operator?.abort();
            push({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          } else if (method === 'session/prompt') {
            // Like codex-acp, opencode-acp sets no tool `name` — only ACP's
            // `kind` plus a `title` that for an execution is the command line.
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'opencode-session-1',
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
                sessionId: 'opencode-session-1',
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
                _meta: {},
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

function writes(
  all: Record<string, unknown>[],
  method: string,
): Array<Record<string, unknown> | undefined> {
  return all.filter((message) => message['method'] === method);
}

function configOption(
  all: Record<string, unknown>[],
  configId: string,
): Record<string, unknown> | undefined {
  return all.find(
    (message) =>
      message['method'] === 'session/set_config_option' &&
      (message['params'] as { configId?: unknown } | undefined)?.configId === configId,
  );
}

describe('openCodeMode', () => {
  it('collapses every Verity posture into one of the two OpenCode modes', () => {
    expect(openCodeMode('plan')).toBe('plan');
    // Everything that is not planning is `build`, including the postures Claude
    // spells differently and the unattended meta-turn one. Pinned as a list rather
    // than a default-branch assertion: this function returning a caller value is
    // what would breach §5b, and only a fixed output keeps `permissionModes`
    // legitimately undeclared on the profile.
    for (const mode of [
      undefined,
      'auto',
      'default',
      'acceptEdits',
      'dontAsk',
      'bypassPermissions',
    ])
      expect(openCodeMode(mode)).toBe('build');
  });
});

describe('AcpOpenCodeBackend', () => {
  it('runs an OpenCode turn through ACP, carrying the system directives in the prompt', async () => {
    const fake = acpSpawner();
    let steer: ((message: { text: string }) => boolean) | undefined;
    const running = new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-1',
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
    // `runAcpTurn` gate. The Conductor queues the message as its own turn instead.
    // Asserted separately from the gate: `onSteer` is registered synchronously,
    // before `runAcpTurn`'s first await, and if that ever stops being true the
    // optional call would read `undefined`, which is not `false` but says nothing
    // about the gate.
    expect(steer).toBeDefined();
    expect(steer?.({ text: 'change direction' })).toBe(false);
    const result = await running;
    expect(result).toMatchObject({ sessionId: 'opencode-session-1', exitCode: 0, aborted: false });
    // OpenCode has no system-prompt channel over ACP, so the directives ride in
    // front of the turn's own prompt text.
    expect(write(fake.writes, 'session/prompt')).toMatchObject({
      params: {
        sessionId: 'opencode-session-1',
        prompt: [{ type: 'text', text: 'Verity runtime policy\n\nDo it' }],
      },
    });
    // Claude's `claudeCode` session options must not leak into this agent.
    expect(write(fake.writes, 'session/new')).toMatchObject({
      params: { cwd: '/work/project', mcpServers: [] },
    });
    expect(write(fake.writes, 'session/new')).not.toHaveProperty('params._meta.claudeCode');
    expect((await ctx.store.getEvents('verity-opencode-1')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'tool_call_start',
      'tool_call',
      'text',
      'result',
      'status',
    ]);
    expect(fake.kill).toHaveBeenCalled();
  });

  it('never sends session/set_mode — OpenCode advertises no ACP modes block', async () => {
    const fake = acpSpawner();
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-2',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      permissionMode: 'plan',
      spawner: fake.spawner,
    });
    // The posture reaches the agent as a config option. Arming the shared loop's
    // `sessionMode` path instead would send a request this agent does not
    // implement, and the whole turn would fail on the error it answers with.
    expect(write(fake.writes, 'session/set_mode')).toBeUndefined();
    expect(configOption(fake.writes, 'mode')).toMatchObject({
      params: { sessionId: 'opencode-session-1', configId: 'mode', value: 'plan' },
    });
  });

  it('runs a turn with no stated posture in build mode', async () => {
    const fake = acpSpawner();
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-3',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Asserted rather than left to the session's own default: `session/new` already
    // reports `build`, and it would be easy to skip the write and inherit whatever
    // the operator's opencode config last selected.
    expect(configOption(fake.writes, 'mode')).toMatchObject({ params: { value: 'build' } });
  });

  it('selects the requested model through the standard session config option', async () => {
    const fake = acpSpawner();
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-4',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'deepinfra/zai-org/GLM-5.2',
      spawner: fake.spawner,
    });
    // Verity's provider-qualified id is OpenCode's own spelling, so it is passed
    // through unparsed — unlike Codex, where the `codex/` prefix has to come off.
    expect(configOption(fake.writes, 'model')).toMatchObject({
      params: {
        sessionId: 'opencode-session-1',
        configId: 'model',
        value: 'deepinfra/zai-org/GLM-5.2',
      },
    });
    // Both options are set before the prompt, and model before mode.
    const order = (configId: string): number =>
      fake.writes.findIndex(
        (message) =>
          message['method'] === 'session/set_config_option' &&
          (message['params'] as { configId?: unknown }).configId === configId,
      );
    expect(order('model')).toBeGreaterThanOrEqual(0);
    expect(order('mode')).toBeGreaterThan(order('model'));
    expect(fake.writes.findIndex((m) => m['method'] === 'session/prompt')).toBeGreaterThan(
      order('mode'),
    );
  });

  it('keeps the session model and notices when the requested one is unavailable', async () => {
    const fake = acpSpawner();
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-5',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'deepinfra/nobody/Nothing-9',
      spawner: fake.spawner,
    });
    // The OpenCode picker is the operator's pinned `VERITY_EXTRA_MODELS` list, which
    // has no way to know what the sandbox's opencode config actually serves — so a
    // stale entry is expected and must not cost the turn.
    expect(result.exitCode).toBe(0);
    expect(configOption(fake.writes, 'model')).toBeUndefined();
    const notice = (await ctx.store.getEvents('verity-opencode-5')).find((e) => e.t === 'notice');
    // Both models are named. The `session` event above this one was written before the
    // model could be selected and records the REQUESTED id, so if the notice did not
    // name the one that actually served the turn, nothing in the transcript would.
    expect(notice).toMatchObject({
      t: 'notice',
      text: expect.stringContaining('deepinfra/nobody/Nothing-9'),
    });
    expect(notice).toMatchObject({
      t: 'notice',
      text: expect.stringContaining('opencode/big-pickle'),
    });
    // The mode is independent and still applied — one unavailable value must not
    // take the posture down with it.
    expect(configOption(fake.writes, 'mode')).toMatchObject({ params: { value: 'build' } });
  });

  it('sets nothing on a build that exposes neither config option', async () => {
    const fake = acpSpawner({ withoutModelOption: true, withoutModeOption: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-6',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      model: 'deepinfra/zai-org/GLM-5.2',
      spawner: fake.spawner,
    });
    // An older or differently-configured opencode may expose neither. For a build
    // posture silence is the right answer: `build` asserts nothing the session does
    // not already do, so it keeps its own defaults and the turn still runs. The plan
    // posture is the opposite case — see the two tests below.
    expect(result.exitCode).toBe(0);
    expect(writes(fake.writes, 'session/set_config_option')).toEqual([]);
    expect((await ctx.store.getEvents('verity-opencode-6')).some((e) => e.t === 'notice')).toBe(
      false,
    );
  });

  it('fails a plan turn the session exposes no mode option for', async () => {
    const fake = acpSpawner({ withoutModeOption: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-6b',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: 'plan',
      spawner: fake.spawner,
    });
    // Plan mode is the ONLY thing standing between this turn and live edit tools, so
    // a session that cannot be put into it cannot run the turn as asked. Degrading to
    // `build` would produce exactly the unauthorised writes the posture forbids, and
    // it would do so silently — the operator asked for planning and got edits.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no session "mode" option');
    expect(writes(fake.writes, 'session/prompt')).toEqual([]);
  });

  it('does not tell the operator the mode was kept on a turn it then fails', async () => {
    const fake = acpSpawner({ modeWithoutPlan: true });
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-6d',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: 'plan',
      spawner: fake.spawner,
    });
    // The unavailable-value notice reads "keeping the session's mode", which is true
    // of a model that could not be selected and false of a posture that ends the
    // turn. Printing both would leave a transcript saying the session carried on
    // immediately above the error saying it did not.
    const events = await ctx.store.getEvents('verity-opencode-6d');
    expect(events.some((event) => event.t === 'notice')).toBe(false);
    expect(events.some((event) => event.t === 'error')).toBe(true);
  });

  it('fails a plan turn when the mode option does not offer plan', async () => {
    const fake = acpSpawner({ modeWithoutPlan: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-6c',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: 'plan',
      spawner: fake.spawner,
    });
    // Same conclusion by the other route: the option exists but this session's
    // vocabulary has no `plan` in it. An unavailable MODEL is survivable and only
    // earns a notice; an unavailable posture is not.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not offer "plan" mode');
    expect(writes(fake.writes, 'session/prompt')).toEqual([]);
  });

  it('fails a plan turn the session acknowledges and then reports as build', async () => {
    const fake = acpSpawner({ echoStaleMode: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-6e',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: 'plan',
      spawner: fake.spawner,
    });
    // The write was answered without an error, so the ack alone would have let the
    // turn run — with edit tools live, which is the one outcome plan mode exists to
    // prevent. The same answer carries the resulting options, and they say `build`.
    // Reading them back is what turns a hopeful ack into a checked fact.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('accepted "plan" mode and then reported another');
    expect(writes(fake.writes, 'session/prompt')).toEqual([]);
  });

  it('names a tool call by its ACP kind, not by the command line in the title', async () => {
    const fake = acpSpawner();
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-7',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(
      (await ctx.store.getEvents('verity-opencode-7')).filter((event) => event.t === 'tool_call'),
    ).toEqual([expect.objectContaining({ t: 'tool_call', id: 'call_1', name: 'Bash' })]);
  });

  it('raises a permission card for a tool call and answers the agent with the choice', async () => {
    const fake = acpSpawner({ permission: true });
    const seen: Array<{ tool: string; toolUseId: string; input: Record<string, unknown> }> = [];
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-perm',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Clean up',
      // No posture stated, so `openCodeMode` yields `build` — the same mode every
      // non-plan Verity posture collapses to. That collapse is only safe because the
      // per-tool cards below still gate the tools, so this is where "build" stops
      // meaning "run everything unattended".
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (request, respond) => {
        seen.push({
          tool: request.toolName,
          toolUseId: request.toolUseId,
          input: request.input,
        });
        respond({ behavior: 'deny', message: 'denied' });
      },
    });
    expect(result.exitCode).toBe(0);
    // opencode-acp sends no tool `name`, so the card is named from ACP's `kind` —
    // never from `title`, which for an execution is the command line itself. The
    // command still reaches the card, as the input the operator is approving.
    expect(seen).toEqual([
      { tool: 'Bash', toolUseId: 'call_perm', input: { command: 'rm -rf build' } },
    ]);
    const events = await ctx.store.getEvents('verity-opencode-perm');
    expect(events.find((event) => event.t === 'permission')).toMatchObject({
      t: 'permission',
      id: 'call_perm',
      tool: 'Bash',
      // ADR 0014 D3: the card reads the channel to decide which standing grant
      // scopes it may offer, and every ACP prompt is on the ACP channel.
      grantChannel: 'acp',
    });
    // The decision has to reach the agent, not just the timeline: the tool is the
    // agent's to run, and a card nobody answers back is a card that stopped nothing.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'reject' } },
      }),
    );
  });

  it('refuses rather than stalls when an unattended posture meets a permission card', async () => {
    const fake = acpSpawner({ permission: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-perm-unattended',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Clean up',
      // `dontAsk` is what `Conductor.query` pins for a turn no one is watching. On
      // Claude it means the agent does not ask; on OpenCode there is no such mode, so
      // `openCodeMode` collapses it to `build` — where OpenCode's own config decides
      // whether a tool raises a card, and one may well arrive with nobody to answer it.
      permissionMode: 'dontAsk',
      spawner: fake.spawner,
    });
    // The shared loop answers it itself: no approval UI wired means every request is
    // refused (`acp-backend.ts`), so the turn finishes with the tool declined instead
    // of hanging on a card nobody will see. That is the honest outcome of the collapse
    // — an unattended OpenCode turn gets fewer tools than the same turn on Claude, and
    // it gets them refused rather than silently allowed.
    expect(result.exitCode).toBe(0);
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'reject' } },
      }),
    );
  });

  it('forwards a gateway it is handed, leaving admission an upstream decision', async () => {
    const fake = acpSpawner({ httpMcp: true });
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-8',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Use Verity tools',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'unused-turn-bearer' },
    });
    // The transport CAN carry the gateway — that is what `mcpCapabilities.http`
    // says — and the profile offers it when a caller supplies one. Nothing here
    // stops that; what stops it in production is upstream: `opencode-acp` is absent
    // from `ACP_WORKER_BACKENDS`, so no bearer is ever minted for its turns. This
    // pins the case that a bearer reaching this backend anyway is not an accident
    // the profile silently absorbs — if this expectation ever has to flip, the
    // decision to admit OpenCode to the gateway has to be made and written down.
    expect(write(fake.writes, 'session/new')).toMatchObject({
      params: {
        mcpServers: [
          {
            type: 'http',
            name: 'verity',
            url: 'http://relay:8080/internal/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer unused-turn-bearer' }],
          },
        ],
      },
    });
  });

  it('sends an image attachment inline', async () => {
    const fake = acpSpawner();
    await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-9',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Look',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'aGk=' }],
      spawner: fake.spawner,
    });
    // opencode-acp advertises `promptCapabilities.image`, so the retired HTTP
    // transport's file-materialization path simply does not apply.
    expect(write(fake.writes, 'session/prompt')).toMatchObject({
      params: {
        prompt: [
          { type: 'text', text: 'Look' },
          { type: 'image', mimeType: 'image/png', data: 'aGk=' },
        ],
      },
    });
  });

  it('resumes a persisted OpenCode conversation through session/load', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-opencode-10',
      worktree: '/work/project',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    const fake = acpSpawner();
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-10',
      resumeSessionId: 'opencode-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // The retired transport had no resume at all; ACP's `loadSession: true` is what
    // makes an OpenCode session survive a Verity restart.
    expect(result.sessionId).toBe('opencode-session-existing');
    expect(write(fake.writes, 'session/new')).toBeUndefined();
    expect(configOption(fake.writes, 'mode')).toMatchObject({
      params: { sessionId: 'opencode-session-existing', value: 'build' },
    });
  });

  it('reports no bind when the agent refuses to load the resumed conversation', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-opencode-11',
      worktree: '/work/project',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    const fake = acpSpawner({ loadNotFound: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-11',
      resumeSessionId: 'opencode-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // Echoing the attempted id back would let the conductor write it as the
    // session's bind, so the next turn resumes the same refused conversation and
    // fails identically — the session wedges instead of recovering cold.
    //
    // Reporting no id is only half of that: the bind ALREADY on the session is not
    // replaced by a run that mints none, so `staleResume` is what actually tells the
    // conductor to drop it. This is the path a session bound to a pre-ACP
    // `opencode serve` id takes on its first turn after the upgrade.
    expect(result).toMatchObject({ sessionId: undefined, exitCode: 1, staleResume: true });
    expect(result.stderr).toContain('Resource not found: opencode-session-existing');
    // The two recovery classifications must not both fire on one result: the
    // conductor's cold retry reads `staleResume`, while `maybeAutoResume` further
    // out replays the WHOLE turn on `failedBeforeExecution`. A refused load is
    // pre-execution in the plain sense, so this asserts the classifier's actual
    // rule — an auth/quota phrase in stderr — rather than that intuition.
    expect(result.failedBeforeExecution).toBeUndefined();
  });

  it('keeps the bind when the agent refuses the load for a reason of the moment', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-opencode-13',
      worktree: '/work/project',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    const fake = acpSpawner({ loadAuthRequired: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-13',
      resumeSessionId: 'opencode-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // An answered refusal, but not one about the conversation: the agent is not
    // logged in. Only `resourceNotFound` says the conversation is gone. Treating
    // every JSON-RPC error as proof of that would throw away a live thread the
    // moment a provider key expires — and the id, once unbound, cannot be
    // recovered.
    expect(result.exitCode).toBe(1);
    expect(result.staleResume).toBeUndefined();
  });

  it('keeps the bind when the adapter dies mid-load instead of refusing', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-opencode-14',
      worktree: '/work/project',
      model: 'deepinfra/zai-org/GLM-5.2',
    });
    const fake = acpSpawner({ loadCrash: true });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-14',
      resumeSessionId: 'opencode-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // A dead pipe says nothing about whether the conversation exists. Calling this
    // stale would discard a perfectly good conversation over one bad process start,
    // and the operator would silently lose the thread's context.
    expect(result.exitCode).toBe(1);
    expect(result.staleResume).toBeUndefined();
  });

  it('settles an operator cancel without badging the session crashed', async () => {
    const controller = new AbortController();
    const fake = acpSpawner({ cancel: { operator: controller } });
    const result = await new AcpOpenCodeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-opencode-12',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ exitCode: 0, aborted: true });
    expect((await ctx.store.getEvents('verity-opencode-12')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'result',
    ]);
  });
});
