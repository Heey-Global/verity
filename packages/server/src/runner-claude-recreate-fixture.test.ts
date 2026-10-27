import { AcpClaudeBackend, nodeSpawner } from '@verity/session';
import { createTestDb } from '@verity/store/testing';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { unexpectedStderrLines } from './runner-claude-live-stderr.js';

it.each([false, true])(
  'answers a post-prompt title request (same input write: %s)',
  async (sameChunk) => {
    const root = await mkdtemp(join(tmpdir(), 'recreate-title-'));
    const child = spawn(
      process.execPath,
      [
        resolve('scripts/fixtures/fake-claude-recreate-smoke.mjs'),
        '--session-id',
        'fixture-title',
        '--input-format',
        'stream-json',
      ],
      {
        env: {
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: join(root, 'claude'),
          VERITY_LIVE_SMOKE_WORKTREE: root,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = once(child, 'close');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
    try {
      await vi.waitFor(() => expect(stdout).toContain('"subtype":"init"'), { timeout: 5_000 });
      const user = frame({
        type: 'user',
        message: { role: 'user', content: 'seed before sandbox recreate' },
      });
      const title = frame({
        type: 'control_request',
        request_id: 'title-after-user',
        request: {
          subtype: 'generate_session_title',
          description: 'Sandbox recreate smoke',
          persist: true,
        },
      });
      if (sameChunk) child.stdin.write(user + title);
      else {
        child.stdin.write(
          user +
            frame({
              type: 'control_request',
              request_id: 'before-title',
              request: { subtype: 'get_context_usage' },
            }),
        );
        // Observe a response after the user frame before sending the title request.
        await vi.waitFor(() => expect(stdout).toContain('"request_id":"before-title"'), {
          timeout: 5_000,
        });
        expect(stdout).not.toContain('"type":"result"');
        child.stdin.write(title);
      }
      await vi.waitFor(() => expect(stdout).toContain('"request_id":"title-after-user"'), {
        timeout: 5_000,
      });
      await vi.waitFor(() => expect(stdout).toContain('"type":"result"'), { timeout: 5_000 });
      const lines = stdout.trim().split('\n');
      const response = lines.find((line) => line.includes('"request_id":"title-after-user"'))!;
      expect(JSON.parse(response)).toEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'title-after-user',
          response: { title: 'Sandbox recreate smoke' },
        },
      });
      expect(lines.indexOf(response)).toBeLessThan(
        lines.findIndex((line) => line.includes('"type":"result"')),
      );
      child.stdin.end();
      expect((await closed)[0], stderr).toBe(0);
      expect(stderr).toBe('');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
