import { createSecretCipher } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTrustedCliOutputStore } from './trusted-cli-output.js';
import * as frameSpool from './secret-job-frame-spool.js';
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

  it('keeps pagination open when frames arrive after the ownership lookup', async () => {
    const original = frameSpool.createPostgresSecretJobFrameSpool;
    let appendDuringRead: (() => Promise<void>) | undefined;
    const spy = vi
      .spyOn(frameSpool, 'createPostgresSecretJobFrameSpool')
      .mockImplementation((...args) => {
        const spool = original(...args);
        return {
          ...spool,
          readPage: async (...readArgs) => {
            await appendDuringRead?.();
            return spool.readPage(...readArgs);
          },
        };
      });
    try {
      const store = createTrustedCliOutputStore(ctx.db, cipher);
      const id = await store.begin(owner);
      await store.append(id, 'stdout', 'first');
      // The ownership receipt predates these committed frames; its count must not end paging.
      appendDuringRead = async () => {
        appendDuringRead = undefined;
        await store.append(id, 'stdout', 'second');
      };
      await expect(store.read(owner, id)).resolves.toMatchObject({ hasMore: true, nextCursor: 1 });
      await expect(store.read(owner, id, 1)).resolves.toMatchObject({
        hasMore: false,
        frames: [expect.objectContaining({ payload: 'second' })],
      });
    } finally {
      spy.mockRestore();
    }
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
    // The inline response is unchanged, yet a caller that never saw it can still find it.
    const { invocations } = await store.list(owner);
    expect(invocations).toEqual([
      {
        invocationId: expect.any(String),
        startedAt: expect.any(String),
        complete: true,
        terminationReason: 'process_exit',
        exitCode: 0,
      },
    ]);
    let text = '';
    let cursor = 0;
    for (;;) {
      const page = (await store.read(owner, invocations[0]!.invocationId, cursor)) as {
        frames: { payload: string }[];
        nextCursor: number;
        hasMore: boolean;
        complete: boolean;
      };
      expect(page.complete).toBe(true);
      text += page.frames.map((frame) => frame.payload).join('');
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(text).toBe('x'.repeat(9000));
  });

  it('still returns a complete inline result when it cannot be retained', async () => {
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
    expect(result).toMatchObject({ exitCode: 0, stdout: 'small response' });
    expect(result.terminationReason).toBe('process_exit');
    // A record left running would hold a full reservation until its lease expired.
    expect((await sql`select * from trusted_cli_outputs`.execute(ctx.db)).rows).toHaveLength(0);
  });

  it("lists only the owner's runs, newest first, with status but no output", async () => {
    let time = new Date('2026-10-13T12:00:00Z');
    const store = createTrustedCliOutputStore(ctx.db, cipher, () => time);
    const finished = await store.begin(owner);
    await store.append(finished, 'stdout', 'private output text');
    await store.finish(finished, {
      exitCode: 1,
      exitCodeKnown: false,
      terminationReason: 'timeout',
      stdout: 'private output text',
    });
    time = new Date('2026-10-13T12:01:00Z');
    const running = await store.begin(owner);
    await store.begin({ ...owner, sessionId: 'other' });
    await store.begin({ ...owner, projectId: 'other' });
    const listing = await store.list(owner);
    expect(listing).toEqual({
      invocations: [
        { invocationId: running, startedAt: '2026-10-13T12:01:00.000Z', complete: false },
        {
          invocationId: finished,
          startedAt: '2026-10-13T12:00:00.000Z',
          complete: true,
          terminationReason: 'timeout',
          exitCode: 1,
          exitCodeKnown: false,
        },
      ],
    });
    expect(JSON.stringify(listing)).not.toContain('private output');
    await expect(store.list({ ...owner, sessionId: 'nobody' })).resolves.toEqual({
      invocations: [],
    });
    // Both leases (one hour after completion, two hours for the abandoned run) have expired.
    time = new Date('2026-10-13T14:01:00Z');
    await expect(store.list(owner)).resolves.toEqual({ invocations: [] });
  });

  it('bounds the listing to the twenty newest runs', async () => {
    let time = new Date('2026-10-13T12:00:00Z');
    const store = createTrustedCliOutputStore(ctx.db, cipher, () => time);
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      time = new Date(Date.parse('2026-10-13T12:00:00Z') + i * 1000);
      const id = await store.begin(owner);
      await store.finish(id, { exitCode: 0, terminationReason: 'process_exit' });
      ids.push(id);
    }
    const { invocations } = await store.list(owner);
    expect(invocations.map((entry) => entry.invocationId)).toEqual(ids.slice(2).reverse());
  });

  it('does not let retained small results reduce concurrency', async () => {
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
    expect((await sql`select * from trusted_cli_outputs`.execute(ctx.db)).rows).toHaveLength(6);
    // Finished records reserve only their stored bytes, so all five running slots remain.
    for (let i = 0; i < 5; i++) await store.begin(owner);
    await expect(store.begin(owner)).rejects.toThrow('quota');
  });

  it('counts retained output by its actual stored bytes per project and in total', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    // byte_length is what the quota reads; a synthetic frame avoids writing 40 MiB.
    const retain = async (projectId: string, id: string, bytes: number) => {
      await sql`insert into trusted_cli_outputs (id, project_id, session_id, expires_at, next_sequence, result) values (${id}, ${projectId}, 'session', now() + interval '1 hour', 1, 'done')`.execute(
        ctx.db,
      );
      await sql`insert into secret_job_frames (job_id, sequence, protocol_version, stream, encoding, payload, byte_length, emitted_at, created_at) values (${id}, 0, 1, 'stdout', 'utf8', 'synthetic', ${bytes}, now(), now())`.execute(
        ctx.db,
      );
    };
    const mib = 1024 * 1024;
    await retain('project', 'below', 50 * mib - 1);
    await expect(store.begin(owner)).resolves.toEqual(expect.any(String));
    await retain('project', 'at-limit', 1);
    // 50 MiB retained in this project; a running record elsewhere is still admitted.
    await expect(store.begin(owner)).rejects.toThrow('quota');
    await expect(store.begin({ ...owner, projectId: 'fresh' })).resolves.toEqual(
      expect.any(String),
    );
    for (let i = 0; i < 3; i++) await retain(`full-${i}`, `full-${i}`, 50 * mib);
    // 200 MiB retained across projects closes admission everywhere.
    await expect(store.begin({ ...owner, projectId: 'another' })).rejects.toThrow('quota');
  });

  it('bounds the number of retained records that stored almost nothing', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const retain = (projectId: string, count: number) =>
      sql`insert into trusted_cli_outputs (id, project_id, session_id, expires_at, next_sequence, result)
        select ${projectId} || '-' || n, ${projectId}, 'session', now() + interval '1 hour', 0, 'done'
        from generate_series(1, ${count}) n`.execute(ctx.db);
    await retain('project', 199);
    await expect(store.begin(owner)).resolves.toEqual(expect.any(String));
    await retain('extra', 1);
    await sql`update trusted_cli_outputs set project_id = 'project' where project_id = 'extra'`.execute(
      ctx.db,
    );
    await expect(store.begin(owner)).rejects.toThrow('quota');
    await retain('a', 200);
    await retain('b', 200);
    await retain('c', 200);
    await expect(store.begin({ ...owner, projectId: 'd' })).resolves.toEqual(expect.any(String));
    await retain('e', 200);
    await expect(store.begin({ ...owner, projectId: 'f' })).rejects.toThrow('quota');
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
    expect(result.exitCodeKnown).toBe(false);
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
    expect(result.exitCodeKnown).toBe(false);
    expect(result.outputAvailable).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private database detail');
    await expect(store.read(owner, result.invocationId!)).resolves.toMatchObject({
      complete: false,
      hasMore: true,
    });
  });

  it('marks the failure exit code as synthetic when the final output flush fails', async () => {
    const store = createTrustedCliOutputStore(ctx.db, cipher);
    const result = await collectTrustedCliOutput(
      {
        ...store,
        append: async () => {
          throw new Error('storage unavailable');
        },
      },
      owner,
      redactors(),
      async ({ onOutput }) => {
        await onOutput('stdout', Buffer.from('short'));
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputMode: 'stream-v1',
          terminationReason: 'process_exit',
        };
      },
    );
    expect(result).toMatchObject({
      terminationReason: 'storage_failure',
      exitCode: 1,
      exitCodeKnown: false,
    });
    await expect(store.read(owner, result.invocationId!)).resolves.toMatchObject({
      result: { exitCode: 1, exitCodeKnown: false },
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
