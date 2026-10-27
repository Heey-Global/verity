import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixture = fileURLToPath(
  new URL('../../../scripts/fixtures/fake-claude-recreate-smoke.mjs', import.meta.url),
);
const sessionId = '00000000-0000-4000-8000-000000000001';

describe('Claude recreation fixture control handshake', () => {
  it.each([false, true])(
    'answers title requests before completing the turn (combined=%s)',
    async (combined) => {
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
          response: { title: 'Sandbox recreation smoke' },
        });
        expect((await next()).type).toBe('assistant');
        expect((await next()).type).toBe('result');
        send({ ...title, request_id: 'title-after-result' });
        expect((await next()).response?.request_id).toBe('title-after-result');
        child.stdin.end();
        const exitCode = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        const transcript = await readFile(
          join(home, 'projects', root.replaceAll('/', '-'), `${sessionId}.jsonl`),
          'utf8',
        );
        expect(transcript.trim().split('\n')).toHaveLength(1);
        expect(JSON.parse(transcript).type).toBe('user');
      } finally {
        child.kill();
        lines.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
