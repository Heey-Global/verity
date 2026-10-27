import { AcpClaudeBackend, nodeSpawner } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { unexpectedStderrLines } from './runner-claude-live-stderr.js';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sessionId = '00000000-0000-4000-8000-000000000001';

describe('Claude smoke fixture control handshake', () => {
  it.each(
    ['recreate', 'live'].flatMap((kind) => [false, true].map((combined) => ({ kind, combined }))),
  )(
    'answers title requests before completing the turn ($kind, combined=$combined)',
    async ({ kind, combined }) => {
      const fixture = fileURLToPath(
        new URL(`../../../scripts/fixtures/fake-claude-${kind}-smoke.mjs`, import.meta.url),
      );
      const root = await mkdtemp(join(tmpdir(), 'claude-recreate-fixture-'));
      const home = join(root, 'claude');
      const child = spawn(
        process.execPath,
        [fixture, '--session-id', sessionId, '--input-format', 'stream-json'],
        {
          env: {
            PATH: process.env.PATH,
            CLAUDE_CONFIG_DIR: home,
            VERITY_LIVE_SMOKE_WORKTREE: root,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const lines = createInterface({ input: child.stdout });
      const iterator = lines[Symbol.asyncIterator]();
      const next = async () => {
        const line = await iterator.next();
        expect(line.done).toBe(false);
        return JSON.parse(line.value!) as {
          type: string;
          response?: { request_id: string; response: { title?: string } };
        };
      };
      const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (data: string) => {
        stderr += data;
      });
      try {
        expect((await next()).type).toBe('system');
        const user = {
          type: 'user',
          message: { role: 'user', content: 'seed before sandbox recreate' },
        };
        const title = {
          type: 'control_request',
          request_id: 'title-1',
          request: { subtype: 'generate_session_title' },
        };
        if (combined) {
          child.stdin.write(`${JSON.stringify(user)}\n${JSON.stringify(title)}\n`);
        } else {
          send(user);
          // A synchronized control response proves the fixture read beyond the
          // user frame, rather than relying on both frames sharing an OS chunk.
          send({
            type: 'control_request',
            request_id: 'barrier',
            request: { subtype: 'set_permission_mode' },
          });
          expect((await next()).response?.request_id).toBe('barrier');
          send(title);
        }
        const response = await next();
        expect(response.type).toBe('control_response');
        expect(response.response).toEqual({
          subtype: 'success',
          request_id: 'title-1',
          response: { title: kind === 'live' ? 'Sandbox live smoke' : 'Sandbox recreate smoke' },
        });
        expect((await next()).type).toBe('assistant');
        if (kind === 'live') {
          send({ ...title, request_id: 'title-during-restart' });
          expect((await next()).response?.request_id).toBe('title-during-restart');
          await writeFile(join(root, 'continue'), 'ready\n');
          expect((await next()).type).toBe('assistant');
        }
        expect((await next()).type).toBe('result');
        send({ ...title, request_id: 'title-after-result' });
        expect((await next()).response?.request_id).toBe('title-after-result');
        child.stdin.end();
        const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        if (kind === 'recreate') {
          const transcript = await readFile(
            join(home, 'projects', root.replaceAll('/', '-'), `${sessionId}.jsonl`),
            'utf8',
          );
          expect(transcript.trim().split('\n')).toHaveLength(1);
          expect(JSON.parse(transcript).type).toBe('user');
        }
      } finally {
        child.kill();
        lines.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

it('serves title requests through the pinned ACP adapter before and after transcript restore', async () => {
  const ctx = await createTestDb();
  const root = await mkdtemp(join(tmpdir(), 'recreate-acp-'));
  const worktree = join(root, 'work');
  const home = join(root, 'claude');
  await mkdir(worktree);
  const backend = new AcpClaudeBackend();
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: root,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_EXECUTABLE: resolve('scripts/fixtures/fake-claude-recreate-smoke.mjs'),
    VERITY_LIVE_SMOKE_WORKTREE: worktree,
  };
  try {
    await ctx.store.createSession({ sessionId: 'recreate', worktree, model: 'smoke' });
    const options = {
      store: ctx.store,
      storeSessionId: 'recreate',
      worktree,
      cwd: worktree,
      model: 'smoke',
      command: process.execPath,
      extraArgs: [
        fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')),
      ],
      spawner: nodeSpawner,
      env,
    };
    const seed = await backend.run({
      ...options,
      prompt: 'seed before sandbox recreate',
      signal: AbortSignal.timeout(10_000),
    });
    expect(seed.exitCode, seed.stderr).toBe(0);
    expect(seed.aborted, seed.stderr).toBe(false);
    expect(seed.sessionId).toBeDefined();
    expect(unexpectedStderrLines(seed.stderr ?? '')).toEqual([]);
    const transcriptPath = join(
      home,
      'projects',
      worktree.replaceAll('/', '-'),
      `${seed.sessionId}.jsonl`,
    );
    const transcript = await readFile(transcriptPath, 'utf8');
    await rm(home, { recursive: true, force: true });
    await mkdir(join(home, 'projects', worktree.replaceAll('/', '-')), { recursive: true });
    await writeFile(transcriptPath, transcript);
    const resumed = await backend.run({
      ...options,
      prompt: 'resume after sandbox recreate',
      resumeSessionId: seed.sessionId!,
      signal: AbortSignal.timeout(10_000),
    });
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.aborted, resumed.stderr).toBe(false);
    expect(resumed.sessionId).toBe(seed.sessionId);
    expect(unexpectedStderrLines(resumed.stderr ?? '')).toEqual([]);
    const observation = JSON.parse(
      await readFile(join(worktree, 'recreate-observed.json'), 'utf8'),
    ) as { restored: string; databaseEnvironment: string[] };
    expect(observation.restored).toBe(transcript);
    expect(observation.databaseEnvironment).toEqual([]);
    expect((await readFile(transcriptPath, 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally {
    await ctx.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
