import { createIsolatedTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpClaudeBackend } from './acp-claude-backend.js';
import { GATEWAY_UNAVAILABLE_DIRECTIVE } from './acp-backend.js';
import type { SpawnedProcess, Spawner } from './backend-contract.js';

let ctx: TestDb;
beforeAll(async () => {
  // This file advances fake timers over teardown work. Keep its store in-process:
  // fake-timer advancement cannot drive the socket I/O of the shared PostgreSQL harness.
  ctx = await createIsolatedTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
});

function acpSpawner(
  behavior: {
    promptError?: boolean;
    loadSession?: boolean;
    /** Answer `initialize` with the agent's HTTP MCP capability set the way the
     *  real adapter reports it: an explicit boolean either way, never absent. */
    httpMcp?: boolean;
    /** Refuse `session/load` the way the real adapter refuses a conversation it
     *  cannot restore: JSON-RPC -32002 naming the requested id. */
    loadNotFound?: boolean;
    /** Ask for tool permission the way the real agent does: emit the referenced
     *  `tool_call` first, then the request, and answer the prompt once the
     *  client has decided. */
    permission?: boolean;
    /** Offer the ordinary request a durable-grant option whose opaque id happens
     *  to spell one of the session's modes, the way another ACP agent's option
     *  vocabulary could collide with Verity's posture. */
    collidingAlways?: boolean;
    /** Spell the ordinary request's one-shot allow — the option Verity actually
     *  picks — as a session mode, and announce a switch to it afterwards, the
     *  way an agent whose own mode moved for unrelated reasons would. */
    collidingAllowOnce?: boolean;
    /** Spell EVERY option of the ordinary request as a session mode, so the
     *  option set alone is indistinguishable from a plan approval's. Only the
     *  tool the card names still tells them apart. */
    collidingEveryOption?: boolean;
    /** Ask for approval the way `ExitPlanMode` does: one allow option per
     *  permission posture, so answering the card also picks the mode the rest
     *  of the turn runs in. The adapter announces the switch it made as a
     *  `current_mode_update` before settling the prompt. */
    planPermission?: boolean;
    /** Answer `session/new` with the mode catalogue the real adapter reports,
     *  so the turn loop has a posture to pin the session to. */
    modes?: { currentModeId: string; availableModes: string[] };
    /** Switch the session's mode mid-turn the way an agent does on its own, then
     *  park the prompt until the client has pulled the session back. */
    modeDrift?: string;
    /** Refuse the pull-back the drift provokes, the way an agent that no longer
     *  serves that mode would. */
    refuseRestore?: boolean;
    /** Announce a SECOND switch while the first pull-back is still in flight, and
     *  refuse the pull-back that one provokes — an agent that keeps moving its
     *  own mode while the client is busy putting it back. */
    driftAgain?: string;
    /** How many of those follow-up switches to announce, one per pull-back.
     *  More than the client re-samples turns the agent into one that never stops
     *  moving; the default of one lets it settle on the next pass. */
    driftAgainTimes?: number;
    /** Announce a switch to this mode and THEN ask for plan approval, leaving the
     *  pull-back the switch provoked unanswered until the approval has been
     *  answered. That is the window where an agent applying the pull-back late
     *  would overwrite the posture the approval just chose. */
    driftBeforePlan?: string;
    /** Refuse the very first pin, the way an agent whose mode catalogue narrowed
     *  after `session/new` — a model selected during session setup that cannot
     *  run the pinned posture — answers the assertion. */
    refusePin?: boolean;
    /** Settle the prompt as soon as the drift is announced, so the pull-back is
     *  still in flight when the turn's own work is already done. */
    promptBeforeRestore?: boolean;
    /** Never answer the pull-back at all, the way a wedged agent would. */
    dropRestore?: boolean;
    /** Answer `session/prompt` only when the test calls `finishPrompt()`, after
     *  streaming one agent chunk — the window in which a real turn is live and
     *  has actually said something, so steering is safe to inject. */
    holdPrompt?: boolean;
    /** Which update that held turn streams first. `plan_update` is a turn whose
     *  only output so far is a mutation of a plan carried over from an earlier
     *  turn — agent work, but no prose. Defaults to `agent_message_chunk`. */
    holdPromptArm?: 'agent_message_chunk' | 'plan_update';
    /** Return `stopReason: 'cancelled'`, optionally cancelling the run first so
     *  the turn settles as an operator cancel rather than a timeout stop.
     *  `disconnect` instead drops the ACP process without answering the prompt,
     *  the way an adapter that ignores `session/cancel` dies on the kill
     *  backstop. */
    cancel?: { operator?: AbortController; disconnect?: boolean };
    /** Reject `session/prompt` with the engine's own end-of-turn diagnostic and
     *  stream NOTHING first — the shape an agent engine reports when a turn ends
     *  holding no assistant message. `operator` aborts before the rejection, the
     *  way a cancel landing before the first token does. */
    promptInternalError?: { operator?: AbortController };
    /** Reject the request that opens the conversation — `session/new`, or
     *  `session/load` on a resume — with this JSON-RPC error, the way an adapter
     *  whose credentials the gateway refused answers before any prompt goes out. */
    sessionOpenError?: string;
    /** What the adapter process wrote on stderr. The real one prints the reason a
     *  login was refused there and leaves JSON-RPC holding a bare transport error. */
    stderr?: string;
    /** Claude Agent SDK quota metadata forwarded by claude-agent-acp 0.70.0. */
    rateLimit?: Record<string, unknown>;
    /** Never settle `exited`, the way an adapter that ignores SIGTERM leaves the
     *  process standing. The only thing that clears the kill escalation is this
     *  promise, so it is also the only way to observe the escalation firing. */
    exitHangs?: boolean;
    /** Simulate a spawner whose first teardown signal throws synchronously. */
    termKillThrows?: boolean;
  } = {},
): {
  spawner: Spawner;
  writes: Record<string, unknown>[];
  /** Every `session/set_mode` the client sent, in order. */
  setModes: string[];
  /** Announce a mode switch at a moment the test picks, for the windows the
   *  agent's own scripted behavior cannot reach. */
  drift: (modeId: string) => void;
  /** Settle a `holdPrompt` turn once the test is done with the live window. */
  finishPrompt: () => void;
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
  const kill = vi.fn((signal?: NodeJS.Signals) => {
    if (signal === 'SIGTERM' && behavior.termKillThrows === true) {
      close();
      throw new Error('kill channel closed');
    }
    close();
  });
  const writes: Record<string, unknown>[] = [];
  const setModes: string[] = [];
  let promptId: unknown;
  /** The pull-back whose answer `driftBeforePlan` is holding back. */
  let heldSetModeId: unknown;
  /** `driftBeforePlan` settles the prompt from whichever of two paths gets
   *  there first, and a JSON-RPC id may only be answered once. */
  let promptSettled = false;
  const settlePrompt = (): void => {
    if (promptSettled) return;
    promptSettled = true;
    push({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  };
  /** The `ExitPlanMode` tool call and the approval card that references it —
   *  one allow option per posture, so the answer also picks the session's mode. */
  const pushPlanPermission = (): void => {
    push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'claude-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'toolu_plan',
          status: 'pending',
          kind: 'other',
          title: 'Ready to code?',
          rawInput: { plan: 'Ship it' },
          _meta: { claudeCode: { toolName: 'ExitPlanMode' } },
        },
      },
    });
    push({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'claude-session-1',
        toolCall: {
          toolCallId: 'toolu_plan',
          kind: 'other',
          title: 'Ready to code?',
          rawInput: { plan: 'Ship it' },
        },
        // The adapter's own `ExitPlanMode` option set: each allow is a
        // permission posture, and the one the client picks becomes the
        // session's mode for the rest of the turn.
        options: [
          { optionId: 'auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
          {
            optionId: 'acceptEdits',
            name: 'Yes, and auto-accept edits',
            kind: 'allow_always',
          },
          {
            optionId: 'default',
            name: 'Yes, and manually approve edits',
            kind: 'allow_once',
          },
          { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
        ],
      },
    });
  };
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
  const spawner: Spawner = (command, _args, options): SpawnedProcess => {
    expect(command).toBe('claude-agent-acp');
    expect(options.keepStdinOpen).toBe(true);
    return {
      stdout,
      pid: 123,
      exited: behavior.exitHangs === true ? new Promise<number>(() => {}) : Promise.resolve(0),
      stderr: () => behavior.stderr ?? '',
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
                  ...(behavior.httpMcp !== undefined
                    ? { mcpCapabilities: { http: behavior.httpMcp, sse: false } }
                    : {}),
                },
              },
            });
          } else if (
            (method === 'session/new' || method === 'session/load') &&
            behavior.sessionOpenError !== undefined
          ) {
            push({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: behavior.sessionOpenError },
            });
          } else if (method === 'session/new') {
            push({
              jsonrpc: '2.0',
              id,
              result: {
                sessionId: 'claude-session-1',
                ...(behavior.modes !== undefined
                  ? {
                      modes: {
                        currentModeId: behavior.modes.currentModeId,
                        availableModes: behavior.modes.availableModes.map((mode) => ({
                          id: mode,
                          name: mode,
                        })),
                      },
                    }
                  : {}),
              },
            });
          } else if (method === 'session/set_mode') {
            setModes.push((message['params'] as { modeId: string }).modeId);
            if (behavior.driftBeforePlan !== undefined) {
              // 1 is the pin at session setup. 2 is the pull-back the switch
              // provoked — held, so it is unanswered while the approval card is
              // answered. 3 is the re-assertion of the adopted posture, which
              // only exists if the client noticed the contest.
              if (setModes.length === 2) {
                heldSetModeId = id;
                return true;
              }
              push({ jsonrpc: '2.0', id, result: {} });
              if (setModes.length >= 3) settlePrompt();
              return true;
            }
            if (behavior.dropRestore === true && setModes.length > 1) return true;
            const refused =
              (behavior.refuseRestore === true && setModes.length > 1) ||
              (behavior.refusePin === true && setModes.length === 1) ||
              (behavior.driftAgain !== undefined &&
                setModes.length > (behavior.driftAgainTimes ?? 1) + 1);
            const answer = refused
              ? { jsonrpc: '2.0', id, error: { code: -32602, message: 'unsupported mode' } }
              : { jsonrpc: '2.0', id, result: {} };
            // Announced after the client has stopped draining and before this
            // pull-back is answered, so the tail it is waiting on is already the
            // older one by the time that answer arrives. Pushing it in the same
            // batch instead would let the drain that started the pull-back pick
            // it up too, which is the case that never had a gap.
            if (
              behavior.driftAgain !== undefined &&
              setModes.length >= 2 &&
              setModes.length <= (behavior.driftAgainTimes ?? 1) + 1
            ) {
              setTimeout(
                () =>
                  push({
                    jsonrpc: '2.0',
                    method: 'session/update',
                    params: {
                      sessionId: 'claude-session-1',
                      update: {
                        sessionUpdate: 'current_mode_update',
                        currentModeId: behavior.driftAgain,
                      },
                    },
                  }),
                10,
              );
            }
            // An agent that answers the mode change a tick after the prompt is
            // the case the turn has to wait out; answering in the same batch
            // would be settled by the drain's own tick either way.
            if (behavior.promptBeforeRestore === true) setTimeout(() => push(answer), 20);
            else push(answer);
            // The drift case parks the prompt until the client has pulled the
            // session back, so the assertion cannot race a restore the turn
            // loop deliberately fires without awaiting it.
            if (
              behavior.modeDrift !== undefined &&
              behavior.promptBeforeRestore !== true &&
              setModes.length > 1
            ) {
              push({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
            }
          } else if (method === 'session/load' && behavior.loadNotFound === true) {
            push({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32002,
                message: 'Resource not found: claude-session-existing',
                data: { uri: 'claude-session-existing' },
              },
            });
          } else if (method === 'session/load') {
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-existing',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Replayed history.' },
                },
              },
            });
            push({ jsonrpc: '2.0', id, result: {} });
          } else if (method === 'session/prompt' && behavior.modeDrift !== undefined) {
            promptId = id;
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update: {
                  sessionUpdate: 'current_mode_update',
                  currentModeId: behavior.modeDrift,
                },
              },
            });
            if (behavior.promptBeforeRestore === true || behavior.dropRestore === true) {
              push({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
            }
          } else if (method === 'session/prompt' && behavior.driftBeforePlan !== undefined) {
            promptId = id;
            // Switch first, ask second, on the same batch: the client drains
            // updates before it answers a permission request, so the pull-back
            // is already on the wire when the approval card is answered.
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update: {
                  sessionUpdate: 'current_mode_update',
                  currentModeId: behavior.driftBeforePlan,
                },
              },
            });
            pushPlanPermission();
          } else if (method === 'session/prompt' && behavior.planPermission === true) {
            promptId = id;
            pushPlanPermission();
          } else if (method === 'session/prompt' && behavior.permission === true) {
            promptId = id;
            // `ensureToolCallEmitted`: the tool call the permission references
            // always exists first, and only IT carries the real tool name —
            // the permission payload below has just ACP's `title`, which for
            // Bash is the command line.
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: 'toolu_1',
                  status: 'pending',
                  kind: 'execute',
                  title: 'rm -rf /tmp/should-not-run',
                  rawInput: { command: 'rm -rf /tmp/should-not-run' },
                  _meta: { claudeCode: { toolName: 'Bash' } },
                },
              },
            });
            push({
              jsonrpc: '2.0',
              id: 'permission-1',
              method: 'session/request_permission',
              params: {
                sessionId: 'claude-session-1',
                toolCall: {
                  toolCallId: 'toolu_1',
                  kind: 'execute',
                  title: 'rm -rf /tmp/should-not-run',
                  rawInput: { command: 'rm -rf /tmp/should-not-run' },
                },
                options: [
                  {
                    optionId:
                      behavior.collidingAllowOnce === true || behavior.collidingEveryOption === true
                        ? 'dontAsk'
                        : 'allow',
                    name: 'Allow',
                    kind: 'allow_once',
                  },
                  ...(behavior.collidingAlways === true || behavior.collidingEveryOption === true
                    ? [{ optionId: 'auto', name: 'Allow every time', kind: 'allow_always' }]
                    : []),
                  {
                    optionId: behavior.collidingEveryOption === true ? 'plan' : 'reject',
                    name: 'Reject',
                    kind: 'reject_once',
                  },
                ],
              },
            });
          } else if (message['id'] === 'permission-1' && 'result' in message) {
            if (behavior.driftBeforePlan !== undefined) {
              // The answer moved the session, and only NOW does the held
              // pull-back get its answer — an agent that applies it after the
              // approval it was already racing. The prompt is settled by the
              // re-assertion above; the timer is the fallback for a client that
              // never sends one, so that case fails on the modes rather than
              // hanging until the suite's timeout.
              const outcome = (message['result'] as { outcome: { optionId?: string } }).outcome;
              if (outcome.optionId !== undefined) {
                push({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'claude-session-1',
                    update: {
                      sessionUpdate: 'current_mode_update',
                      currentModeId: outcome.optionId,
                    },
                  },
                });
              }
              const held = heldSetModeId;
              heldSetModeId = undefined;
              if (held !== undefined) push({ jsonrpc: '2.0', id: held, result: {} });
              setTimeout(settlePrompt, 50);
              return true;
            }
            if (behavior.planPermission === true || behavior.collidingAllowOnce === true) {
              // The adapter switches the session into the posture the chosen
              // option names and announces it, exactly as an approved plan does.
              const outcome = (message['result'] as { outcome: { optionId?: string } }).outcome;
              if (outcome.optionId !== undefined) {
                push({
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'claude-session-1',
                    update: {
                      sessionUpdate: 'current_mode_update',
                      currentModeId: outcome.optionId,
                    },
                  },
                });
              }
            }
            push({
              jsonrpc: '2.0',
              id: promptId,
              result: { stopReason: 'end_turn' },
            });
          } else if (method === 'session/prompt' && behavior.promptInternalError !== undefined) {
            behavior.promptInternalError.operator?.abort();
            push({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message:
                  'Internal error: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
              },
            });
          } else if (method === 'session/prompt' && behavior.holdPrompt === true) {
            promptId = id;
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update:
                  behavior.holdPromptArm === 'plan_update'
                    ? {
                        sessionUpdate: 'plan_update',
                        plan: { type: 'items', planId: 'plan-1', entries: [] },
                      }
                    : {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'Working…' },
                      },
              },
            });
          } else if (method === 'session/prompt' && behavior.cancel !== undefined) {
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Working…' },
                },
              },
            });
            behavior.cancel.operator?.abort();
            if (behavior.cancel.disconnect === true) close();
            else push({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          } else if (method === 'session/prompt') {
            if (behavior.rateLimit !== undefined) {
              push({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'claude-session-1',
                  update: {
                    sessionUpdate: 'usage_update',
                    used: 3,
                    size: 200_000,
                    _meta: { '_claude/rateLimit': behavior.rateLimit },
                  },
                },
              });
            }
            push({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'claude-session-1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Done.' },
                },
              },
            });
            if (behavior.promptError === true) {
              push({ jsonrpc: '2.0', id, error: { code: -32603, message: 'agent crashed' } });
            } else {
              push({
                jsonrpc: '2.0',
                id,
                result: {
                  stopReason: 'end_turn',
                  usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 },
                },
              });
            }
          }
        }
        return true;
      },
    };
  };
  const drift = (modeId: string): void => {
    push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'claude-session-1',
        update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
      },
    });
  };
  const finishPrompt = (): void => {
    push({
      jsonrpc: '2.0',
      id: promptId,
      result: {
        stopReason: 'end_turn',
        usage: { totalTokens: 5, inputTokens: 3, outputTokens: 2 },
      },
    });
  };
  return { spawner, writes, setModes, drift, finishPrompt, kill };
}

const CLAUDE_MODES = {
  currentModeId: 'default',
  availableModes: ['auto', 'default', 'acceptEdits', 'plan', 'dontAsk'],
};

describe('AcpClaudeBackend', () => {
  it('does not fall back to the native Claude CLI for stateless helper queries', () => {
    expect('query' in new AcpClaudeBackend()).toBe(false);
  });

  it('runs a Claude turn through ACP without advertising host filesystem or terminal access', async () => {
    const fake = acpSpawner();
    let steer: ((message: { text: string }) => boolean) | undefined;
    const running = new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-1',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      appendSystemPrompt: 'Verity runtime policy',
      spawner: fake.spawner,
      onSteer: (inject) => {
        steer = inject;
      },
    });
    // The turn has not produced a single agent token yet, so it is not steerable
    // (see the steering test below). The Conductor queues the message instead.
    expect(steer?.({ text: 'change direction' })).toBe(false);
    const result = await running;
    expect(result).toMatchObject({ sessionId: 'claude-session-1', exitCode: 0, aborted: false });
    const initialize = fake.writes.find((message) => message['method'] === 'initialize');
    expect(initialize).toMatchObject({
      params: {
        clientCapabilities: {
          _meta: { 'subagent-transcript': true },
        },
      },
    });
    expect(initialize).not.toHaveProperty('params.clientCapabilities.fs');
    expect(initialize).not.toHaveProperty('params.clientCapabilities.terminal');
    const session = fake.writes.find((message) => message['method'] === 'session/new');
    expect(session).toMatchObject({
      params: {
        cwd: '/work/project',
        mcpServers: [],
        _meta: {
          systemPrompt: { append: 'Verity runtime policy' },
        },
      },
    });
    expect((await ctx.store.getEvents('verity-session-1')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'result',
      'status',
    ]);
    expect(fake.kill).toHaveBeenCalled();
    expect(steer?.({ text: 'too late' })).toBe(false);
    expect(fake.writes.some((message) => message['method'] === '_session/steering')).toBe(false);
  });

  it('escalates the adapter to SIGKILL when SIGTERM leaves it standing', async () => {
    // An adapter that ignores SIGTERM used to survive its own turn and keep holding the
    // sandbox's memory. `exitHangs` is that adapter: nothing ever settles `exited`, so
    // only the escalation can take it down.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = acpSpawner({ exitHangs: true });
      await new AcpClaudeBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-session-kill-escalation',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Do it',
        spawner: fake.spawner,
      });
      expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
      // Past the 5s escalation grace.
      vi.advanceTimersByTime(10_000);
      expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not escalate an adapter that exited on SIGTERM', async () => {
    // The other half: a turn that settles normally must not have a SIGKILL waiting for
    // a pid that, by then, may belong to somebody else.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = acpSpawner();
      await new AcpClaudeBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-session-kill-no-escalation',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Do it',
        spawner: fake.spawner,
      });
      vi.advanceTimersByTime(10_000);
      expect(fake.kill.mock.calls).toEqual([['SIGTERM']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still escalates when the initial SIGTERM call throws', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = acpSpawner({ exitHangs: true, termKillThrows: true });
      await new AcpClaudeBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-session-kill-throws',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Do it',
        spawner: fake.spawner,
      });
      vi.advanceTimersByTime(10_000);
      expect(fake.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists Claude ACP quota updates for the existing usage meters', async () => {
    const fake = acpSpawner({
      rateLimit: {
        status: 'allowed_warning',
        resetsAt: 1_783_630_800,
        rateLimitType: 'seven_day',
        utilization: 0.81,
      },
    });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-quota',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });

    expect(await ctx.store.getEvents('verity-session-quota')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: 'rate_limit',
          status: 'allowed_warning',
          resetsAt: 1_783_630_800,
          window: 'weekly',
          usedPercent: 81,
          providerLabel: 'Claude',
        }),
      ]),
    );
  });

  // ADR 0014 D1: an ACP turn reaches the brokered Verity tools over the Server's
  // loopback MCP gateway, offered on `session/new` and authenticated with the
  // bearer minted for this turn alone.
  it('offers the loopback gateway as an HTTP MCP server when the agent advertises HTTP MCP', async () => {
    const fake = acpSpawner({ httpMcp: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-mcp',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'turn-bearer' },
    });
    expect(result).toMatchObject({ exitCode: 0 });
    expect(fake.writes.find((message) => message['method'] === 'session/new')).toMatchObject({
      params: {
        mcpServers: [
          {
            type: 'http',
            name: 'verity',
            url: 'http://relay:8080/internal/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer turn-bearer' }],
          },
        ],
      },
    });
  });

  // An agent that cannot speak HTTP MCP would be handed a server it can never
  // call, so the bearer stays with the Server rather than travelling for nothing.
  it('withholds the gateway from an agent that does not advertise HTTP MCP', async () => {
    const fake = acpSpawner({ httpMcp: false });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-no-mcp',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'turn-bearer' },
    });
    const session = fake.writes.find((message) => message['method'] === 'session/new');
    expect(session).toMatchObject({ params: { mcpServers: [] } });
    expect(JSON.stringify(fake.writes)).not.toContain('turn-bearer');
  });

  it('tells the turn when it was entitled to the gateway and did not get it', async () => {
    const fake = acpSpawner({ httpMcp: false });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-no-mcp-notice',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      appendSystemPrompt: 'Existing directives.',
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'turn-bearer' },
    });
    const session = fake.writes.find((message) => message['method'] === 'session/new');
    expect(session).toMatchObject({ params: { mcpServers: [] } });
    const append = (
      (session?.['params'] as { _meta?: { systemPrompt?: { append?: string } } } | undefined)?._meta
        ?.systemPrompt ?? {}
    ).append;
    expect(append).toContain(GATEWAY_UNAVAILABLE_DIRECTIVE);
    expect(append).toContain('Existing directives.');
    expect(JSON.stringify(fake.writes)).not.toContain('turn-bearer');
  });

  it('adds no unavailability note when the gateway was actually offered', async () => {
    const fake = acpSpawner({ httpMcp: true });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-mcp-no-notice',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      mcpGateway: { url: 'http://relay:8080/internal/mcp', token: 'turn-bearer' },
    });
    expect(JSON.stringify(fake.writes)).not.toContain('Brokered Verity tools unavailable');
  });

  it('refuses to steer a turn that has not produced agent content yet', async () => {
    const fake = acpSpawner({ holdPrompt: true });
    let steer: ((message: { text: string }) => boolean) | undefined;
    const running = new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-steer',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      onSteer: (inject) => {
        steer = inject;
      },
    });
    // Injecting here would append a user message to a turn holding no assistant
    // message, which makes the agent engine abort the process outright
    // (`[ede_diagnostic] result_type=user last_content_type=n/a`) and crash the
    // whole session. Refusing hands the message back to the Conductor to queue.
    expect(steer?.({ text: 'too early' })).toBe(false);
    // Once the agent has streamed a chunk, the same channel accepts the message
    // into the running turn.
    await vi.waitFor(() => {
      expect(steer?.({ text: 'change direction' })).toBe(true);
    });
    fake.finishPrompt();
    await running;
    const steering = fake.writes.filter((message) => message['method'] === '_session/steering');
    expect(steering).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          sessionId: 'claude-session-1',
          prompt: [{ type: 'text', text: 'change direction' }],
        }),
      }),
    ]);
  });

  it('arms steering on a plan mutation from a turn that has emitted no prose', async () => {
    // A turn whose first output only UPDATES a plan carried over from an earlier
    // turn has done agent work all the same, so it is steerable. Arming on the
    // fresh `plan` alone would leave such a turn unsteerable for its whole
    // lifetime and push every follow-up into a separate --resume turn.
    const fake = acpSpawner({ holdPrompt: true, holdPromptArm: 'plan_update' });
    let steer: ((message: { text: string }) => boolean) | undefined;
    const running = new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-steer-plan',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      onSteer: (inject) => {
        steer = inject;
      },
    });
    expect(steer?.({ text: 'too early' })).toBe(false);
    await vi.waitFor(() => {
      expect(steer?.({ text: 'change direction' })).toBe(true);
    });
    fake.finishPrompt();
    await running;
    expect(fake.writes.filter((message) => message['method'] === '_session/steering')).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          sessionId: 'claude-session-1',
          prompt: [{ type: 'text', text: 'change direction' }],
        }),
      }),
    ]);
  });

  it('flushes buffered ACP text before recording a prompt failure', async () => {
    const fake = acpSpawner({ promptError: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-2',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(1);
    const events = await ctx.store.getEvents('verity-session-2');
    expect(events.map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'error',
      'status',
    ]);
    expect(events.find((event) => event.t === 'text')).toMatchObject({
      t: 'text',
      delta: 'Done.',
    });
  });

  it('loads a persisted Claude session in a fresh ACP process without duplicating history', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-3',
      worktree: '/work/project',
      model: 'claude',
    });
    const fake = acpSpawner();
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-3',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    expect(result.sessionId).toBe('claude-session-existing');
    expect(fake.writes.some((message) => message['method'] === 'session/load')).toBe(true);
    expect(fake.writes.some((message) => message['method'] === 'session/resume')).toBe(false);
    expect(
      (await ctx.store.getEvents('verity-session-3')).filter((event) => event.t === 'text'),
    ).toEqual([expect.objectContaining({ t: 'text', delta: 'Done.' })]);
  });

  it('fails clearly when the ACP adapter cannot load a persisted session', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-4',
      worktree: '/work/project',
      model: 'claude',
    });
    const fake = acpSpawner({ loadSession: false });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-4',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // No conversation was opened, so the run reports no bind — see the refused-load
    // test below for why echoing the attempted id back would wedge the session.
    expect(result).toMatchObject({ exitCode: 1, sessionId: undefined });
    expect(result.stderr).toContain('does not support persistent session loading');
    expect(fake.writes.some((message) => message['method'] === 'session/load')).toBe(false);
  });

  it('reports no bind when the adapter refuses to load the resumed conversation', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-8',
      worktree: '/work/project',
      model: 'claude',
    });
    const fake = acpSpawner({ loadNotFound: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-8',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // Reporting the id we tried would let the conductor write it back as the
    // session's bind, so the next turn resumes the same refused conversation and
    // fails identically — the session wedges instead of recovering cold.
    expect(result.sessionId).toBeUndefined();
    expect(result.exitCode).toBe(1);
    // The verdict the conductor keys its stale-resume recovery on must survive.
    expect(result.stderr).toContain('Resource not found: claude-session-existing');
    // A dead pointer is not a rejected credential: replaying the same prompt
    // would resume the same missing conversation and fail identically.
    expect(result.failedBeforeExecution).toBeUndefined();
  });

  it('classifies a refused login as a failure whose prompt never reached the agent', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-14',
      worktree: '/work/project',
      model: 'claude',
    });
    const fake = acpSpawner({ sessionOpenError: 'Authentication failed: token expired' });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-14',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    // `session/prompt` goes out only after the conversation has opened, so a
    // refusal here is positive evidence the turn never ran — the one failure
    // class the conductor may replay.
    expect(result).toMatchObject({ exitCode: 1, failedBeforeExecution: true });
    expect(fake.writes.some((message) => message['method'] === 'session/prompt')).toBe(false);
    // And it leaves no terminal row behind, so the replay stays one logical turn.
    expect(await ctx.store.getEvents('verity-session-14')).toEqual([]);
  });

  it('reads a refusal the adapter printed on stderr, not just the JSON-RPC message', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-15',
      worktree: '/work/project',
      model: 'claude',
    });
    const fake = acpSpawner({
      // What an adapter that died over its credentials leaves on the wire: the
      // reason on stderr, and a bare transport error in its place on JSON-RPC.
      sessionOpenError: 'connection closed',
      stderr: 'claude-agent-acp: invalid api key\n',
    });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-15',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    expect(result.failedBeforeExecution).toBe(true);
  });

  it('refuses to replay a bare transport failure that gives no reason at all', async () => {
    await ctx.store.createSession({
      sessionId: 'verity-session-15b',
      worktree: '/work/project',
      model: 'claude',
    });
    // The mirror image of the test above, and the one that decides whether the
    // classification is worth anything: same unopened session, same bare JSON-RPC
    // error — but nothing on stderr saying why. An unbound session alone proves the
    // prompt never ran; it does NOT prove the failure is one that replaying can get
    // past. A crashed adapter, a killed process or a broken pipe all look like this,
    // and treating them as replayable turns every transport blip into a silent retry.
    const fake = acpSpawner({ sessionOpenError: 'connection closed', stderr: '' });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-15b',
      resumeSessionId: 'claude-session-existing',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Continue',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(1);
    expect(result.failedBeforeExecution).toBeUndefined();
  });

  it('refuses to replay a rate limit the agent reported once the turn was running', async () => {
    const fake = acpSpawner({ promptError: true, stderr: 'rate limit exceeded\n' });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-16',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // The conversation opened and the prompt was dispatched — the rejection
    // phrase alone says nothing about what the agent already did, so the turn
    // terminalizes normally instead of being replayed.
    expect(result.failedBeforeExecution).toBeUndefined();
    expect((await ctx.store.getEvents('verity-session-16')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'error',
      'status',
    ]);
  });

  it('names a permission request by its tool, not by ACP’s command-line title', async () => {
    const fake = acpSpawner({ permission: true });
    const seen: string[] = [];
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-5',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (request, respond) => {
        seen.push(request.toolName);
        respond({ behavior: 'deny', message: 'denied' });
      },
    });
    // The approval card must name the tool the operator is approving. ACP's
    // `title` for Bash is the command itself, which both misnames the card and
    // contradicts the `tool_call` events carrying the same tool id.
    expect(seen).toEqual(['Bash']);
    const events = await ctx.store.getEvents('verity-session-5');
    const permission = events.find((event) => event.t === 'permission');
    // Every prompt through the ACP adapter is on the ACP channel, which the card
    // reads to decide which standing grant scopes it may offer (ADR 0014 D3).
    expect(permission).toMatchObject({
      t: 'permission',
      id: 'toolu_1',
      tool: 'Bash',
      grantChannel: 'acp',
    });
    expect(events.filter((event) => event.t === 'tool_call')).toEqual([
      expect.objectContaining({ t: 'tool_call', id: 'toolu_1', name: 'Bash' }),
    ]);
    // The tool call a permission references must already be on the timeline.
    expect(events.findIndex((event) => event.t === 'tool_call_start')).toBeLessThan(
      events.findIndex((event) => event.t === 'permission'),
    );
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'reject' } },
      }),
    );
  });

  it('answers an ordinary request once, even when an option id spells the mode', async () => {
    const fake = acpSpawner({ permission: true, collidingAlways: true, modes: CLAUDE_MODES });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-17',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (_request, respond) => {
        respond({ behavior: 'allow' });
      },
    });
    // Only a request whose every option names a mode is a posture picker. An
    // ordinary approval is one-shot: a durable grant is Verity's decision to
    // make, and an id that merely looks like a mode must not buy one.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      }),
    );
  });

  it('keeps the pinned posture when an ordinary allow is spelled like a mode', async () => {
    const fake = acpSpawner({ permission: true, collidingAllowOnce: true, modes: CLAUDE_MODES });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-18',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (_request, respond) => {
        respond({ behavior: 'allow' });
      },
    });
    // Approving one tool call never moves the session, so the id Verity picked
    // must not be adopted as the posture. The turn is still owed `auto`, and the
    // switch the agent announces afterwards is drift to pull back from — which
    // it can only be if the pin outlived the approval.
    expect(fake.setModes).toEqual(['auto', 'auto']);
  });

  it('refuses a durable grant to a Bash request dressed as a posture picker', async () => {
    const fake = acpSpawner({ permission: true, collidingEveryOption: true, modes: CLAUDE_MODES });
    const seen: string[] = [];
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-21',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (request, respond) => {
        seen.push(request.toolName);
        respond({ behavior: 'allow' });
      },
    });
    // Every option here names a session mode, so the option set alone reads as a
    // plan approval — but the card the operator answered said `Bash`. Approving
    // a command must stay one-shot: taking the mode-named `allow_always` would
    // turn one approval into a standing grant for every later `rm -rf`.
    expect(seen).toEqual(['Bash']);
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'dontAsk' } },
      }),
    );
    // And the id it did pick is not adopted as the posture either: the turn is
    // still owed `auto`.
    expect(fake.setModes).toEqual(['auto']);
  });

  it('pins the session to the configured permission mode before prompting', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-9',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(fake.setModes).toEqual(['auto']);
    // The mode has to be in place before the first tool call, so the prompt
    // cannot go out while the session still sits in the adapter's own default.
    expect(
      fake.writes.findIndex((message) => message['method'] === 'session/set_mode'),
    ).toBeLessThan(fake.writes.findIndex((message) => message['method'] === 'session/prompt'));
  });

  it('refuses to start a turn whose posture bypasses permissions, before any spawn', async () => {
    // §5b, on the input ACP actually carries the posture in. The turns API and
    // project config bound `permissionMode` upstream, but a Sandbox turn is built
    // from a supervisor start-turn request (`runner-worker-entry.ts`) whose
    // `permissionMode` is a bare string — so the spawn seam has to hold the line.
    const fake = acpSpawner({ modes: CLAUDE_MODES });
    await expect(
      new AcpClaudeBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-session-bypass',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Do it',
        permissionMode: 'bypassPermissions',
        spawner: fake.spawner,
      }),
    ).rejects.toThrow(/§5b/);
    // Refused BEFORE the agent exists, not cleaned up after: a spawned adapter has
    // already been handed the worktree.
    expect(fake.writes).toHaveLength(0);
    expect(await ctx.store.getEvents('verity-session-bypass')).toEqual([]);
  });

  it('still admits the unattended meta-query posture the turns API cannot ask for', async () => {
    // `Conductor.query` pins `dontAsk` so a title/refine query cannot stall on a
    // prompt nobody is there to answer. It is deliberately absent from
    // `ALLOWED_PERMISSION_MODES` — that list bounds the turns API and project
    // config — so the spawn seam must check the profile's vocabulary instead, or
    // every meta query throws before it spawns.
    const fake = acpSpawner({ modes: CLAUDE_MODES });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-dont-ask',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Summarize',
      permissionMode: 'dontAsk',
      spawner: fake.spawner,
    });

    expect(result.exitCode).toBe(0);
    expect(fake.writes.find((message) => message['method'] === 'session/set_mode')).toMatchObject({
      params: { modeId: 'dontAsk' },
    });
  });

  it('leaves the session alone when the model cannot run the configured mode', async () => {
    const fake = acpSpawner({
      modes: { currentModeId: 'default', availableModes: ['default', 'acceptEdits', 'plan'] },
    });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-10',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // The adapter omits `auto` for models that cannot support it. Demanding it
    // anyway is a JSON-RPC error, not a correction — keep its clamped mode.
    expect(fake.setModes).toEqual([]);
  });

  it('approves a mode-carrying plan prompt into the configured mode, not into manual', async () => {
    const fake = acpSpawner({ planPermission: true, modes: CLAUDE_MODES });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-11',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (_request, respond) => {
        respond({ behavior: 'allow' });
      },
    });
    // `ExitPlanMode` offers one allow per posture, so a plain `allow_once` there
    // means "yes, and approve every edit by hand": it drops the session out of
    // `auto` and turns the rest of the turn into a prompt per edit.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'auto' } },
      }),
    );
    // The approval already put the session where Verity wants it, so the mode
    // it announces needs no correction on top.
    expect(fake.setModes).toEqual(['auto']);
  });

  it('leaves a refused plan in planning when no approval UI is wired', async () => {
    const fake = acpSpawner({ planPermission: true, modes: CLAUDE_MODES });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-20',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    // With no card to answer, every request is refused — and on `ExitPlanMode`
    // the refusal IS "no, keep planning", which lands the session in `plan`.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'plan' } },
      }),
    );
    // Pulling that back to `auto` would turn a plan Verity declined to approve
    // into a turn that runs unattended.
    expect(fake.setModes).toEqual(['auto']);
  });

  it('keeps the posture an approved plan chose instead of pulling the turn back into planning', async () => {
    const fake = acpSpawner({ planPermission: true, modes: CLAUDE_MODES });
    await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-13',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: 'plan',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (_request, respond) => {
        respond({ behavior: 'allow' });
      },
    });
    // `plan` is the option to KEEP planning, so a turn pinned to it has no allow
    // option of its own and takes the agent's default choice.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'default' } },
      }),
    );
    // The approval moved the session on purpose. Pulling it back to `plan` would
    // undo the operator's own "yes, go ahead" one update later.
    expect(fake.setModes).toEqual(['plan']);
  });

  it('re-asserts a refused plan behind the pull-back that was already in flight', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES, driftBeforePlan: 'default' });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-24',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      spawner: fake.spawner,
      permissionControl: true,
      onPermissionRequest: (_request, respond) => {
        respond({ behavior: 'deny', message: 'Not yet' });
      },
    });
    expect(result.exitCode).toBe(0);
    // "No, keep planning" — the refusal is what put the session in `plan`.
    expect(fake.writes).toContainEqual(
      expect.objectContaining({
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'plan' } },
      }),
    );
    // The pull-back to `auto` was already on the wire when that refusal was
    // answered, and the agent applied it afterwards. Ordering the two is the
    // agent's business, so the refused posture is asserted once more behind it:
    // without that last `plan` the turn would run on unattended in `auto`,
    // which is the one thing a refused plan must not do.
    expect(fake.setModes).toEqual(['auto', 'auto', 'plan']);
  });

  it('pulls the session back when the agent switches mode mid-turn', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES, modeDrift: 'default' });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-12',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    expect(fake.setModes).toEqual(['auto', 'auto']);
    // The switch is ACP bookkeeping, not transcript content — it must not land
    // as an "Unrecognized event" row between message chunks.
    expect(
      (await ctx.store.getEvents('verity-session-12')).some((event) => event.t === 'raw'),
    ).toBe(false);
  });

  it('says so in the transcript when the mode cannot be restored', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES, modeDrift: 'default', refuseRestore: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-14',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // A refused pull-back is not the turn's failure, but the turn does finish in
    // a posture nobody chose — and the transcript is where the operator sees it.
    expect(result.exitCode).toBe(0);
    const events = await ctx.store.getEvents('verity-session-14');
    expect(events).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining('Could not restore the "auto" permission mode'),
      }),
    );
  });

  it('runs the turn in the agent’s own mode when the pin itself is refused', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES, refusePin: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-19',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // The mode catalogue is reported once, at `session/new`, and selecting a
    // model during setup can narrow it — the pin is the first place that shows.
    // Losing the posture must not lose the turn: the agent's clamped mode is the
    // safe one, so the prompt still goes out and the transcript carries the note.
    expect(result.exitCode).toBe(0);
    const events = await ctx.store.getEvents('verity-session-19');
    expect(events).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining('refused the "auto" permission mode'),
      }),
    );
    expect(fake.writes.some((message) => message['method'] === 'session/prompt')).toBe(true);
    // Disarmed, not retried: a mode this session refuses would fail identically
    // for every pull-back the rest of the turn fires.
    expect(fake.setModes).toEqual(['auto']);
  });

  it('keeps the restore note even when the prompt answers first', async () => {
    const fake = acpSpawner({
      modes: CLAUDE_MODES,
      modeDrift: 'default',
      refuseRestore: true,
      promptBeforeRestore: true,
    });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-15',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    expect(fake.setModes).toEqual(['auto', 'auto']);
    // The turn's own work finished while the pull-back was still in flight.
    // Closing out on that alone would drop its outcome on the floor.
    const events = await ctx.store.getEvents('verity-session-15');
    expect(events).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining('Could not restore the "auto" permission mode'),
      }),
    );
    // …and it still lands before the turn's own closing rows.
    expect(events.findIndex((event) => event.t === 'notice')).toBeLessThan(
      events.findIndex((event) => event.t === 'result'),
    );
  });

  it('waits out a drift announced while the pull-back is still settling', async () => {
    const fake = acpSpawner({
      modes: CLAUDE_MODES,
      modeDrift: 'default',
      promptBeforeRestore: true,
      driftAgain: 'plan',
    });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-21',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    // Pin, the pull-back for the first switch, and the one for the switch
    // announced while that was in flight.
    expect(fake.setModes).toEqual(['auto', 'auto', 'auto']);
    // Waiting on the tail sampled before the second switch would close the turn
    // out with the last pull-back still running, and closing out is exactly what
    // silences its note — so the outcome the operator needs would be the one
    // that goes missing.
    const events = await ctx.store.getEvents('verity-session-21');
    expect(events).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining('Could not restore the "auto" permission mode'),
      }),
    );
    expect(events.findIndex((event) => event.t === 'notice')).toBeLessThan(
      events.findIndex((event) => event.t === 'result'),
    );
  });

  it('leaves a switch announced after the turn closed out alone', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES });
    // The turn's `result` row is written after it has closed out and while the
    // ACP connection is still live — the one window where a notification can
    // still be dispatched into a transcript that has stopped listening. The
    // agent has no way to aim at it, so the store write is what aims for it.
    const store = new Proxy(ctx.store, {
      get(target, property, receiver) {
        if (property !== 'appendEvent') return Reflect.get(target, property, receiver) as unknown;
        return async (...args: Parameters<typeof target.appendEvent>) => {
          const written = await target.appendEvent(...args);
          if (args[1].t === 'result') fake.drift('default');
          return written;
        };
      },
    });
    const result = await new AcpClaudeBackend().run({
      store,
      storeSessionId: 'verity-session-23',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result.exitCode).toBe(0);
    // Only the pin. Pulling back here would move the agent's own session after
    // the turn's last row, with no transcript left to say whether it worked —
    // and the next turn pins the posture at `session/new` regardless.
    expect(fake.setModes).toEqual(['auto']);
  });

  it('stops re-sampling an agent that never stops switching modes', async () => {
    const fake = acpSpawner({
      modes: CLAUDE_MODES,
      modeDrift: 'default',
      promptBeforeRestore: true,
      driftAgain: 'plan',
      driftAgainTimes: 10,
    });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-22',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Following every switch would let an agent hold the turn open one mode
    // change at a time, so the re-sampling is bounded — and the bound is a
    // different blind spot from an agent that answers nothing, because this one
    // answered every time and moved again anyway.
    expect(result.exitCode).toBe(0);
    expect(await ctx.store.getEvents('verity-session-22')).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining('kept switching away from the "auto" permission mode'),
      }),
    );
  });

  it('says the posture is unknown when the agent never answers the restore', async () => {
    const fake = acpSpawner({ modes: CLAUDE_MODES, modeDrift: 'default', dropRestore: true });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-16',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Waiting out an agent that answers nothing is bounded, and giving up on it
    // leaves exactly the blind spot a refusal would — so it reads the same way.
    expect(result.exitCode).toBe(0);
    expect(await ctx.store.getEvents('verity-session-16')).toContainEqual(
      expect.objectContaining({
        t: 'notice',
        text: expect.stringContaining(
          'never answered the change back to the "auto" permission mode',
        ),
      }),
    );
  });

  it('settles an operator cancel without badging the session crashed', async () => {
    const controller = new AbortController();
    const fake = acpSpawner({ cancel: { operator: controller } });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-6',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ exitCode: 0, aborted: true });
    // Like the native Claude backend, an aborted turn ends on its `result`; the
    // conductor appends the canonical `interrupted` marker. A terminal `status`
    // here would stick as `crashed` in the mobile reducer.
    expect((await ctx.store.getEvents('verity-session-6')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'result',
    ]);
  });

  it('settles an operator cancel that kills the adapter mid-prompt the same way', async () => {
    const controller = new AbortController();
    const fake = acpSpawner({ cancel: { operator: controller, disconnect: true } });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-8',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      signal: controller.signal,
    });
    // An adapter that ignores `session/cancel` dies on the kill backstop, so the
    // prompt never returns and the run settles through the error path. That is
    // still the operator's stop: streamed prose is kept, but no `error` row and
    // no terminal `status` — the diagnostic lives in `stderr` instead.
    expect(result).toMatchObject({ aborted: true, exitCode: 143 });
    expect(result.stderr).toContain('closed');
    expect((await ctx.store.getEvents('verity-session-8')).map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
    ]);
  });

  it('settles a contentless turn the engine aborted after an operator cancel as a stop, not a crash', async () => {
    const controller = new AbortController();
    const fake = acpSpawner({ promptInternalError: { operator: controller } });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-ede-cancel',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
      signal: controller.signal,
    });
    // The engine reports a turn that ended holding no assistant message as a
    // broken turn and takes the process down. Reached by cancelling before the
    // first token, that is the operator's own stop — the native Claude backend
    // settles it as an interrupt, and so must this path: no `error` row, no
    // terminal `status`, and the conductor appends `interrupted`.
    expect(result).toMatchObject({ aborted: true, exitCode: 143 });
    expect(result.stderr).toContain('ede_diagnostic');
    expect(
      (await ctx.store.getEvents('verity-session-ede-cancel')).map((event) => event.t),
    ).toEqual(['session', 'status']);
  });

  it('still records a crash when the engine aborts a contentless turn on its own', async () => {
    const fake = acpSpawner({ promptInternalError: {} });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-ede-crash',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    // Nobody asked for this stop, so it stays a crash — the operator needs to
    // see it. Steering used to be the way to provoke it; that route is closed
    // (see the steering test), but a genuinely broken turn must still badge.
    expect(result).toMatchObject({ aborted: false, exitCode: 1 });
    const events = await ctx.store.getEvents('verity-session-ede-crash');
    expect(events.map((event) => event.t)).toEqual(['session', 'status', 'error', 'status']);
    expect(events.at(-1)).toMatchObject({ t: 'status', state: 'crashed' });
  });

  it('still records a crash when the turn is cancelled without an operator abort', async () => {
    const fake = acpSpawner({ cancel: {} });
    const result = await new AcpClaudeBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-session-7',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: fake.spawner,
    });
    expect(result).toMatchObject({ exitCode: 1, aborted: false });
    const events = await ctx.store.getEvents('verity-session-7');
    expect(events.map((event) => event.t)).toEqual([
      'session',
      'status',
      'text',
      'result',
      'status',
    ]);
    expect(events.at(-1)).toMatchObject({ t: 'status', state: 'crashed' });
  });
});
