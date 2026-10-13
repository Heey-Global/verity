import { createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTrustedCliOutputStore } from './trusted-cli-output.js';
import {
  collectTrustedCliOutput,
  createTrustedCliOutputRedactors,
} from './trusted-cli-output-stream.js';

let ctx: TestDb;
const cipher = createSecretCipher('c'.repeat(64));
const owner = { projectId: 'project', sessionId: 'session' };
beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());
function redactors() {
  return createTrustedCliOutputRedactors([Buffer.from('private-secret')])!;
}

describe('trusted CLI retained output', () => {
  it('redacts encoded secrets across byte and UTF-8 boundaries before encrypted persistence and replays without execution', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const encoded = Buffer.from('private-secret').toString('base64');
    const input = Buffer.from(`🙂 private-secret ${encoded} ${'x'.repeat(32000)} done`);
    const execute = vi.fn(
      async (options: {
        onOutput: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => Promise<void>;
      }) => {
        for (let offset = 0; offset < input.length; offset += 23)
          await options.onOutput('stdout', input.subarray(offset, offset + 23));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1' as const,
          terminationReason: 'process_exit' as const,
        };
      },
    );
    const result = await collectTrustedCliOutput(store, owner, redactors(), execute);
    expect(result.previewTruncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(24576);
    let cursor = 0;
    let text = '';
    let more = true;
    while (more) {
      const page = (await store.read(owner, result.invocationId!, cursor)) as {
        frames: { payload: string }[];
        nextCursor: number;
        hasMore: boolean;
      };
      text += page.frames.map((f) => f.payload).join('');
      cursor = page.nextCursor;
      more = page.hasMore;
    }
    expect(text).toBe(`🙂 [REDACTED] [REDACTED] ${'x'.repeat(32000)} done`);
    await store.read(owner, result.invocationId!);
    expect(execute).toHaveBeenCalledTimes(1);
    const rows = await sql<{ payload: string }>`select payload from secret_job_frames`.execute(
      ctx.db,
    );
    expect(
      rows.rows.every(
        (r) => r.payload.startsWith('enc:v1:') && !r.payload.includes('private-secret'),
      ),
    ).toBe(true);
  });

  it('rejects another session and another project before returning output', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const id = await store.begin(owner);
    await store.append(id, 'stderr', 'failure detail');
    await expect(store.read({ ...owner, sessionId: 'other' }, id)).rejects.toThrow('not found');
    await expect(store.read({ ...owner, projectId: 'other' }, id)).rejects.toThrow('not found');
  });

  it('retains small complete inline output', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const result = await collectTrustedCliOutput(
      store,
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stdout', Buffer.from('x'.repeat(9000)));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'process_exit',
        };
      },
    );
    expect(result.invocationId).toBeUndefined();
    expect(result.outputAvailable).toBeUndefined();
    expect(result.stdout).toHaveLength(9000);
    expect(result.previewTruncated).toBeUndefined();
  });

  it('releases reservations after small inline commands', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    for (let i = 0; i < 6; i++) {
      const result = await collectTrustedCliOutput(
        store,
        owner,
        redactors(),
        async ({ onOutput }) => {
          await onOutput('stdout', Buffer.from('small response'));
          return {
            exitCode: 0,
            stdout: '',
            stderr: '',
            outputMode: 'stream-v1',
            terminationReason: 'process_exit',
          };
        },
      );
      expect(result.stdout).toBe('small response');
      expect(result.invocationId).toBeUndefined();
    }
    expect((await sql`select * from trusted_cli_outputs`.execute(ctx.db)).rows).toHaveLength(0);
  });

  it('honors one-hour completion expiry across storage reconstruction', async () => {
    let time = new Date('2026-10-13T12:00:00Z');
    const store = createTrustedCliOutputStore(ctx.db, cipher, () => time);
    const id = await store.begin(owner);
    await store.append(id, 'stdout', 'durable');
    time = new Date('2026-10-13T12:10:00Z');
    await store.finish(id, { exitCode: 0 });
    time = new Date('2026-10-13T13:09:59Z');
    const restarted = createTrustedCliOutputStore(ctx.db, cipher, () => time);
    await expect(restarted.read(owner, id)).resolves.toMatchObject({ complete: true });
    time = new Date('2026-10-13T13:10:00Z');
    await restarted.cleanup();
    await expect(restarted.read(owner, id)).rejects.toThrow('not found');
    expect((await sql`select * from secret_job_frames`.execute(ctx.db)).rows).toHaveLength(0);
  });

  it('bounds abandoned records and reserves per-project aggregate capacity', async () => {
    let time = new Date('2026-10-13T12:00:00Z');
    const store = createTrustedCliOutputStore(ctx.db, cipher, () => time);
    for (let i = 0; i < 5; i++) await store.begin(owner);
    await expect(store.begin(owner)).rejects.toThrow('quota');
    time = new Date('2026-10-13T14:00:00Z');
    await store.cleanup();
    await expect(store.begin(owner)).resolves.toEqual(expect.any(String));
  });

  it('returns legacy output without claiming retained frames when an older runner is used', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const result = await collectTrustedCliOutput(store, owner, redactors(), async () => ({
      exitCode: 0,
      stdout: '[REDACTED]',
      stderr: '',
    }));
    expect(result).toEqual({ exitCode: 0, stdout: '[REDACTED]', stderr: '' });
    expect((await sql`select * from trusted_cli_outputs`.execute(ctx.db)).rows).toHaveLength(0);
  });

  it('preserves dispatch refusals and never flushes secret tails on incomplete output', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const error = new Error('dispatch refused');
    await expect(
      collectTrustedCliOutput(store, owner, redactors(), async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const result = await collectTrustedCliOutput(
      store,
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stderr', Buffer.from('private-sec'));
        return {
          exitCode: 1,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'timeout',
          timedOut: true,
        };
      },
    );
    expect(result.stderr).toBe('');
    const signalled = await collectTrustedCliOutput(
      store,
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stderr', Buffer.from('private-sec'));
        return {
          exitCode: 1,
          exitCodeKnown: false,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'process_exit',
        };
      },
    );
    expect(signalled.stderr).toBe('');
  });

  it('reports persistence failure safely and retains previously committed frames', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    let calls = 0;
    const failing = {
      ...store,
      append: async (...args: Parameters<typeof store.append>) => {
        if (++calls > 1) throw new Error('private storage details');
        await store.append(...args);
      },
    };
    const result = await collectTrustedCliOutput(
      failing,
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stdout', Buffer.from('safe message '.repeat(400)));
        await onOutput('stderr', Buffer.from('another message '.repeat(400)));
        throw new Error('unreachable');
      },
    );
    expect(result.terminationReason).toBe('storage_failure');
    expect(JSON.stringify(result)).not.toContain('private storage');
    await expect(store.read(owner, result.invocationId!)).resolves.toMatchObject({
      frames: [expect.objectContaining({ stream: 'stdout' })],
    });
  });

  it('keeps the invocation locator when final metadata cannot be stored', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const result = await collectTrustedCliOutput(
      {
        ...store,
        finish: async () => {
          throw new Error('private database detail');
        },
      },
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stdout', Buffer.from('x'.repeat(30000)));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'process_exit',
        };
      },
    );
    expect(result.terminationReason).toBe('storage_failure');
    expect(result.invocationId).toEqual(expect.any(String));
    expect(result.outputAvailable).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private database detail');
    await expect(store.read(owner, result.invocationId!)).resolves.toMatchObject({
      complete: false,
      hasMore: true,
    });
  });

  it('enforces the aggregate reservation limit across projects', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    for (let i = 0; i < 20; i++) await store.begin({ ...owner, projectId: `project-${i}` });
    await expect(store.begin({ ...owner, projectId: 'extra-project' })).rejects.toThrow('quota');
  });

  it('bounds redacted output and reports output overflow while preserving earlier receipts', async () => {
    let persisted = 0;
    const store = {
      begin: vi.fn(async () => 'bounded'),
      append: vi.fn(async (_id: string, _stream: string, text: string) => {
        persisted += Buffer.byteLength(text);
      }),
      finish: vi.fn(async () => {}),
      read: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      cleanup: vi.fn(async () => {}),
    };
    const result = await collectTrustedCliOutput(
      store,
      owner,
      redactors(),
      async ({ onOutput }) => {
        for (let i = 0; i < 170; i++)
          await onOutput(i % 2 ? 'stdout' : 'stderr', Buffer.alloc(65536, 120));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'process_exit',
        };
      },
    );
    expect(result.terminationReason).toBe('output_limit');
    expect(persisted).toBeGreaterThan(9 * 1024 * 1024);
    expect(persisted).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it('fails closed on undecodable UTF-8 without exposing raw output', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const result = await collectTrustedCliOutput(
      store,
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stdout', Buffer.concat([Buffer.from([0xff]), Buffer.alloc(200, 120)]));
        throw new Error('unreachable');
      },
    );
    expect(result.terminationReason).toBe('redaction_failure');
    expect(result.stdout).toBe('');
  });

  it('falls back for secret profiles outside the existing redactor bounds', () => {
    expect(createTrustedCliOutputRedactors([Buffer.from('a')])).toBeUndefined();
    expect(createTrustedCliOutputRedactors([Buffer.alloc(4097)])).toBeUndefined();
  });
});
