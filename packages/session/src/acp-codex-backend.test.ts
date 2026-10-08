import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpCodexBackend, codexToolName } from './acp-codex-backend.js';
import { PLANNING_PERMISSION_MODE } from './runner.js';
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

function largePng(): Buffer {
  const width = 1600;
  const height = 1500;
  const pixels = randomBytes(width * height * 3);
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row++)
    pixels.copy(scanlines, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  const crc = (bytes: Buffer): number => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function acpSpawner(
  behavior: {
    loadSession?: boolean;
    startupFailure?: string;
    promptFailure?: string;
    processExit?: { code: number | null; signal: NodeJS.Signals | null };
    exitDelayMs?: number;
    /** Refuse `session/load` the way the adapter refuses a rollout it cannot
     *  restore: JSON-RPC -32002 naming the requested id. */
    loadNotFound?: boolean;
    /** Answer `session/new` without the `model` config option, as an adapter
     *  build that does not expose it would. */
    withoutModelOption?: boolean;
    /** The mode `session/new` reports the session already opened in. */
    modeId?: string;
    noPlanningMode?: boolean;
    refusePlanningMode?: boolean;
    /** Answer `session/set_config_option` with the full option set, but with the
     *  model still on the one the session opened with. */
    echoStaleModel?: boolean;
    /** Advertise HTTP MCP support in the adapter's initialize response. */
    httpMcp?: boolean;
    cancel?: { operator?: AbortController; disconnect?: boolean };
    generatedImage?: string;
    fragmentImageFrame?: boolean;
  } = {},
): {
  spawner: Spawner;
  writes: Record<string, unknown>[];
  kill: ReturnType<typeof vi.fn>;
} {
  const queue: string[] = [];
  const waiters: Array<(value: IteratorResult<string>) => void> = [];
  let closed = false;
  let exitReady = false;
  let resolveExit: ((code: number) => void) | undefined;
  const enqueue = (value: string): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter({ value, done: false });
  };
  const push = (message: unknown, fragmentAt?: number): void => {
    const value = `${JSON.stringify(message)}\n`;
    if (fragmentAt !== undefined) {
      enqueue(value.slice(0, fragmentAt));
      enqueue(value.slice(fragmentAt));
    } else enqueue(value);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (behavior.exitDelayMs !== undefined)
      setTimeout(() => {
        exitReady = true;
        resolveExit?.(behavior.processExit?.code ?? 1);
      }, behavior.exitDelayMs);
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
        ...(behavior.noPlanningMode ? [] : [{ id: 'read-only', name: 'Read Only' }]),
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
      exited:
        behavior.exitDelayMs === undefined
          ? Promise.resolve(behavior.processExit?.code ?? 0)
          : new Promise<number>((resolve) => {
              resolveExit = resolve;
            }),
      exitDetails: () =>
        closed && (behavior.exitDelayMs === undefined || exitReady)
          ? behavior.processExit
          : undefined,
      stderr: () =>
        (behavior.startupFailure ?? behavior.promptFailure ?? '') +
        (exitReady ? '\nlate stderr' : ''),
      kill,
      closeStdin: close,
      writeStdin(data) {
        for (const line of data.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as Record<string, unknown>;
          writes.push(message);
          const id = message['id'];
          const method = message['method'];
          if (method === 'initialize') {
            if (behavior.startupFailure !== undefined) {
              close();
              return true;
            }
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
          } else if (method === 'session/set_mode' && behavior.refusePlanningMode) {
            push({ jsonrpc: '2.0', id, error: { code: -32602, message: 'mode refused' } });
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
            if (behavior.cancel.disconnect) close();
            else push({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
          } else if (method === 'session/prompt') {
            if (behavior.promptFailure !== undefined) {
              close();
              return true;
            }
            if (behavior.generatedImage) {
              push(
                {
                  jsonrpc: '2.0',
                  method: 'session/update',
                  params: {
                    sessionId: 'codex-session-1',
                    update: {
                      sessionUpdate: 'tool_call_update',
                      toolCallId: 'image_1',
                      status: 'completed',
                      ...(behavior.fragmentImageFrame
                        ? { rawOutput: { status: 'completed', result: behavior.generatedImage } }
                        : {}),
                      content: [
                        {
                          type: 'content',
                          content: {
                            type: 'image',
                            data: behavior.generatedImage,
                            mimeType: 'image/png',
                          },
                        },
                      ],
                      ...(!behavior.fragmentImageFrame
                        ? { rawOutput: { status: 'completed', result: behavior.generatedImage } }
                        : {}),
                    },
                  },
                },
                behavior.fragmentImageFrame ? 9 * 1024 * 1024 : undefined,
              );
            }
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
  it.each([
    { code: 1, signal: null },
    { code: null, signal: 'SIGKILL' as const },
    { code: 0, signal: null },
  ])(
    'persists redacted process details for an unexpected active-turn exit: %j',
    async (processExit) => {
      const append = vi.spyOn(ctx.store, 'appendEvent');
      const secret = 'ghp_' + 'a'.repeat(24);
      const opaque = 'opaque-runtime-credential';
      const fake = acpSpawner({
        promptFailure: `fatal: ${secret} ${opaque}\nCUSTOM_VALUE=private-setting\nlast failure`,
        processExit,
      });
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        worktree: '/work',
        cwd: '/work',
        prompt: 'Run',
        model: 'codex/gpt-6.1-sol',
        env: { CUSTOM_SECRET: opaque },
        spawner: fake.spawner,
      });
      const events = await ctx.store.getEvents('codex-session-1');
      const diagnostic = events.findLast((event) => event.t === 'diagnostic');
      expect(diagnostic).toMatchObject({
        t: 'diagnostic',
        outcome: 'failed',
        exitCode: processExit.code,
        signal: processExit.signal,
        turnActive: true,
        model: 'codex/gpt-6.1-sol',
      });
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
      expect(JSON.stringify(diagnostic)).not.toContain(opaque);
      expect(JSON.stringify(diagnostic)).not.toContain('private-setting');
      expect(diagnostic).toHaveProperty('stderrTail', expect.stringContaining('last failure'));
      expect(result.exitCode).toBe(1);
      const persisted = append.mock.calls.findLast(([, event]) => event.t === 'diagnostic')?.[1];
      expect(JSON.stringify(persisted)).not.toContain(secret);
      expect(JSON.stringify(persisted)).not.toContain(opaque);
      expect(JSON.stringify(persisted)).not.toContain('private-setting');
      append.mockRestore();
    },
  );

  it.each([false, true])(
    'omits process failure details for an intentional stop (disconnect=%s)',
    async (disconnect) => {
      const operator = new AbortController();
      const fake = acpSpawner({
        cancel: { operator, disconnect },
        processExit: { code: null, signal: 'SIGTERM' },
      });
      await new AcpCodexBackend().run({
        store: ctx.store,
        worktree: '/work',
        cwd: '/work',
        prompt: 'Run',
        signal: operator.signal,
        spawner: fake.spawner,
      });
      const events = await ctx.store.getEvents('codex-session-1');
      expect(
        events.filter((event) => event.t === 'diagnostic' && event.outcome === 'failed'),
      ).toEqual([]);
      expect(events.some((event) => event.t === 'diagnostic' && event.exitCode !== undefined)).toBe(
        false,
      );
    },
  );

  it('captures delayed exit details and stderr after transport EOF', async () => {
    await new AcpCodexBackend().run({
      store: ctx.store,
      worktree: '/work',
      cwd: '/work',
      prompt: 'Run',
      spawner: acpSpawner({
        promptFailure: 'fatal error',
        processExit: { code: 1, signal: null },
        exitDelayMs: 30,
      }).spawner,
    });
    const events = await ctx.store.getEvents('codex-session-1');
    expect(events.findLast((event) => event.t === 'diagnostic')).toMatchObject({
      exitCode: 1,
      signal: null,
      turnActive: true,
      stderrTail: expect.stringContaining('late stderr'),
    });
  });

  it('records a startup process failure with no active prompt', async () => {
    await ctx.store.createSession({
      sessionId: 'startup',
      worktree: '/work',
      model: 'codex/default',
    });
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'startup',
      worktree: '/work',
      cwd: '/work',
      prompt: 'Run',
      spawner: acpSpawner({
        startupFailure: 'fatal startup',
        processExit: { code: 1, signal: null },
      }).spawner,
    });
    const events = await ctx.store.getEvents('startup');
    expect(events.findLast((event) => event.t === 'diagnostic')).toMatchObject({
      exitCode: 1,
      signal: null,
      turnActive: false,
      phase: 'initialize',
    });
  });

  it('preserves raw pre-execution rejection evidence for recovery classification', async () => {
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      worktree: '/work',
      cwd: '/work',
      prompt: 'Run',
      spawner: acpSpawner({ startupFailure: 'API key: invalid api key' }).spawner,
    });
    expect(result.failedBeforeExecution).toBe(true);
  });

  it('does not record a process failure for a clean completed turn', async () => {
    await new AcpCodexBackend().run({
      store: ctx.store,
      worktree: '/work',
      cwd: '/work',
      prompt: 'Run',
      spawner: acpSpawner({ processExit: { code: 0, signal: null } }).spawner,
    });
    const events = await ctx.store.getEvents('codex-session-1');
    expect(events.some((event) => event.t === 'diagnostic' && event.outcome === 'failed')).toBe(
      false,
    );
    expect(events.some((event) => event.t === 'diagnostic' && event.exitCode !== undefined)).toBe(
      false,
    );
  });

  it('externalizes an image generation notification larger than the ACP frame limit', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'verity-acp-image-'));
    const png = largePng();
    try {
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-large-image',
        worktree,
        cwd: worktree,
        prompt: 'Generate an image',
        spawner: acpSpawner({ generatedImage: png.toString('base64'), fragmentImageFrame: true })
          .spawner,
      });
      expect(result.exitCode).toBe(0);
      const event = (await ctx.store.getEvents('verity-large-image')).find(
        (item) => item.t === 'tool_result',
      );
      expect(event?.t).toBe('tool_result');
      if (event?.t !== 'tool_result') return;
      const path = (event.output as { savedPath: string }).savedPath;
      expect(await readFile(path)).toEqual(png);
      expect(JSON.stringify(event)).not.toContain(png.toString('base64'));
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  }, 60_000);
  it('rejects a preexisting generated-image path with different bytes', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'verity-acp-image-'));
    const png = largePng();
    const id = createHash('sha256').update(png).digest('hex');
    const path = join(worktree, '.agents', 'generated-images', `${id}.png`);
    try {
      await mkdir(join(worktree, '.agents', 'generated-images'), { recursive: true });
      await writeFile(path, 'different bytes');
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-image-collision',
        worktree,
        cwd: worktree,
        prompt: 'Generate an image',
        spawner: acpSpawner({ generatedImage: png.toString('base64') }).spawner,
      });
      expect(result.exitCode).toBe(1);
      expect(await readFile(path, 'utf8')).toBe('different bytes');
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  }, 60_000);
  it('does not create image directories through a worktree symlink', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'verity-acp-image-'));
    const outside = await mkdtemp(join(tmpdir(), 'verity-acp-outside-'));
    try {
      await symlink(outside, join(worktree, '.agents'));
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-image-symlink',
        worktree,
        cwd: worktree,
        prompt: 'Generate an image',
        spawner: acpSpawner({ generatedImage: largePng().toString('base64') }).spawner,
      });
      expect(result.exitCode).toBe(1);
      await expect(access(join(outside, 'generated-images'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 60_000);
  it('recovers a backfill initialization failure without replaying a prompt', async () => {
    const failed = acpSpawner({
      startupFailure: 'timed out waiting for state db backfill after 30s (status: running)',
    });
    const recovered = acpSpawner();
    let attempts = 0;
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: (...args) => {
        if (++attempts !== 1) return recovered.spawner(...args);
        return {
          ...failed.spawner(...args),
          exited: new Promise<number>((resolve) => setTimeout(() => resolve(1), 50)),
        };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(attempts).toBe(2);
    expect(failed.writes.map((row) => row['method'])).toEqual(['initialize']);
    expect(recovered.writes.filter((row) => row['method'] === 'session/prompt')).toHaveLength(1);
    expect(failed.kill).toHaveBeenCalled();
  }, 10_000);

  it.each(['cancel', 'timeout'] as const)(
    'stops waiting for stalled teardown on %s',
    async (reason) => {
      const controller = new AbortController();
      const failed = acpSpawner({
        startupFailure: 'timed out waiting for state db backfill after 30s (status: running)',
      });
      const spawn = vi.fn<Spawner>((...args) => ({
        ...failed.spawner(...args),
        exited: new Promise<number>(() => {}),
      }));
      const timer = reason === 'cancel' ? setTimeout(() => controller.abort(), 50) : undefined;
      try {
        const result = await new AcpCodexBackend().run({
          store: ctx.store,
          worktree: '/work/project',
          cwd: '/work/project',
          prompt: 'Do it',
          spawner: spawn,
          signal: controller.signal,
          ...(reason === 'timeout' ? { timeoutMs: 50 } : {}),
        });
        expect(result.exitCode).toBe(reason === 'cancel' ? 143 : 1);
        expect(spawn).toHaveBeenCalledTimes(1);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );

  it('does not replay a prompt when a later failure contains the backfill message', async () => {
    const failed = acpSpawner({
      promptFailure: 'timed out waiting for state db backfill after 30s (status: running)',
    });
    const spawn = vi.fn(failed.spawner);
    const result = await new AcpCodexBackend().run({
      store: ctx.store,
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Do it',
      spawner: spawn,
    });
    expect(result.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failed.writes.filter((row) => row['method'] === 'session/prompt')).toHaveLength(1);
  });

  it.each(['cancel', 'timeout', 'unrelated'] as const)(
    'does not retry startup after %s',
    async (reason) => {
      const controller = new AbortController();
      const failed = acpSpawner({
        startupFailure:
          reason === 'unrelated'
            ? 'failed to initialize sqlite state runtime'
            : 'timed out waiting for state db backfill after 30s (status: running)',
      });
      const spawn = vi.fn(failed.spawner);
      const timer = reason === 'cancel' ? setTimeout(() => controller.abort(), 50) : undefined;
      try {
        const result = await new AcpCodexBackend().run({
          store: ctx.store,
          worktree: '/work/project',
          cwd: '/work/project',
          prompt: 'Do it',
          spawner: spawn,
          signal: controller.signal,
          ...(reason === 'timeout' ? { timeoutMs: 50 } : {}),
        });
        expect(result.exitCode).toBe(reason === 'cancel' ? 143 : 1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(failed.writes.map((row) => row['method'])).toEqual(['initialize']);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );

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
    expect(initialize).toHaveProperty('params.clientCapabilities.session.compaction', {});
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
      'diagnostic',
    ]);
    expect(fake.kill).toHaveBeenCalled();
    expect(fake.writes.some((message) => message['method'] === '_session/steering')).toBe(false);
  });

  it('refuses a toolless turn it cannot enforce instead of running it with tools', async () => {
    const fake = acpSpawner({ httpMcp: true });
    await expect(
      new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'verity-codex-toolless',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Transcribe',
        spawner: fake.spawner,
        toolless: true,
      }),
    ).rejects.toThrow('cannot run a turn without tools');
    expect(fake.writes).toEqual([]);
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

  it('runs a planning turn in the read-only sandbox', async () => {
    // Planning must not change files. Full access would leave that to the model's
    // good behaviour; the read-only sandbox makes Codex itself refuse the write.
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-planning',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: PLANNING_PERMISSION_MODE,
      planning: true,
      spawner: fake.spawner,
    });
    expect(write(fake.writes, 'session/set_mode')).toMatchObject({
      params: { modeId: 'read-only' },
    });
  });

  it.each([{ noPlanningMode: true }, { refusePlanningMode: true }])(
    'fails closed when planning posture cannot be applied: %j',
    async (behavior) => {
      const fake = acpSpawner(behavior);
      const result = await new AcpCodexBackend().run({
        store: ctx.store,
        storeSessionId: 'codex-planning-unavailable',
        worktree: '/work/project',
        cwd: '/work/project',
        prompt: 'Plan it',
        planning: true,
        permissionMode: PLANNING_PERMISSION_MODE,
        spawner: fake.spawner,
      });
      expect(result.exitCode).toBe(1);
      expect(write(fake.writes, 'session/prompt')).toBeUndefined();
    },
  );

  it('keeps full access for a plan posture requested outside planning mode', async () => {
    // Only Verity's planning mode has a way back out of the read-only sandbox.
    const fake = acpSpawner();
    await new AcpCodexBackend().run({
      store: ctx.store,
      storeSessionId: 'verity-codex-plan-posture',
      worktree: '/work/project',
      cwd: '/work/project',
      prompt: 'Plan it',
      permissionMode: PLANNING_PERMISSION_MODE,
      spawner: fake.spawner,
    });
    expect(write(fake.writes, 'session/set_mode')).toMatchObject({
      params: { modeId: 'agent-full-access' },
    });
  });

  it('names an MCP call by its server and tool instead of by its execute kind', () => {
    // Otherwise a plan Codex presents through Verity reads as a Bash command and
    // never becomes a plan card.
    expect(
      codexToolName({ toolCallId: 'c1', kind: 'execute', title: 'mcp.verity.verity_present_plan' }),
    ).toBe('mcp__verity__verity_present_plan');
    expect(codexToolName({ toolCallId: 'c2', kind: 'execute', title: 'npm test' })).toBe('Bash');
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
          {
            type: 'text',
            text: 'Verity session attachment ID for the following image: 8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4',
          },
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
      'diagnostic',
    ]);
  });
});
