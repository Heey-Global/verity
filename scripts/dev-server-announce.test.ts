import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function run(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'verity-announce-'));
  directories.push(root);
  const invoke = () =>
    execFileSync(process.execPath, [resolve('agent-seed/bin/verity-dev-server'), ...args], {
      env: { ...process.env, VERITY_DEV_SERVER_STATE_DIR: root, VERITY_SESSION_ID: 'session-1' },
      stdio: 'pipe',
    });
  return { root, invoke };
}
describe('development listener announcement', () => {
  it('writes a label and scan request without creating a share', () => {
    const { root, invoke } = run(['announce', '--port', '5173', '--name', 'Storybook']);
    invoke();
    expect(JSON.parse(readFileSync(join(root, 'announcements/5173.json'), 'utf8'))).toMatchObject({
      port: 5173,
      name: 'Storybook',
      sessionId: 'session-1',
    });
    expect(Number(readFileSync(join(root, 'scan-request'), 'utf8'))).toBeGreaterThan(0);
  });
  it.each([
    ['announce', '--port', '0', '--name', 'app'],
    ['announce', '--port', '../1', '--name', 'app'],
    ['announce', '--port', '5173'],
    ['announce', '--port', '5173', '--name', 'app', '--name', 'other'],
  ])('rejects malformed input %j', (...args) => {
    expect(run(args).invoke).toThrow();
  });
});

describe('managed dev server commands', () => {
  // Missing provisioning must not instruct an agent to bypass managed lifetime control.
  it('reports missing managed capability without recommending a direct start', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('agent-seed/bin/verity-dev-server'), 'list'],
      {
        env: {
          ...process.env,
          VERITY_SESSION_ID: 'session-1',
          VERITY_DEV_SERVER_URL: '',
          VERITY_PROJECT_MEMORY_URL: '',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('restore the managed server capability');
    expect(result.stderr).not.toContain('Start the server yourself');
  });

  // `start` returns before the server answers; the command must wait and print
  // the network address, because the agent repeats that line to the operator.
  it('starts, waits for the server, and prints the address with the capability', async () => {
    const { createServer } = await import('node:http');
    const { writeFileSync } = await import('node:fs');
    const { execFile } = await import('node:child_process');
    const requests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    let polls = 0;
    const server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push({ authorization: request.headers.authorization, body });
        const reply =
          body.action === 'status'
            ? ++polls < 2
              ? { server: 'Demo: starting', state: 'starting' }
              : { server: 'Demo: running at http://verity.local:8104', state: 'running' }
            : { server: 'Demo: starting' };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const root = mkdtempSync(join(tmpdir(), 'verity-managed-cli-'));
    directories.push(root);
    writeFileSync(join(root, 'cap'), 'capability-1\n');
    try {
      const address = server.address() as { port: number };
      const stdout = await new Promise<string>((done, reject) =>
        execFile(
          process.execPath,
          [resolve('agent-seed/bin/verity-dev-server'), 'start', 'Demo'],
          {
            env: {
              ...process.env,
              VERITY_DEV_SERVER_URL: `http://127.0.0.1:${String(address.port)}/internal/dev-servers`,
              VERITY_GH_BROKER_CAPABILITY_FILE: join(root, 'cap'),
              VERITY_SESSION_ID: 'session-1',
            },
          },
          (error, out) => (error ? reject(new Error(error.message)) : done(out)),
        ),
      );
      expect(stdout.trim()).toBe('Demo: running at http://verity.local:8104');
      expect(requests[0]).toEqual({
        authorization: 'Bearer capability-1',
        body: { action: 'start', name: 'Demo', sessionId: 'session-1' },
      });
    } finally {
      server.close();
    }
  }, 30_000);
});

// The toolkit ships its own copy of the agent seed; a fix in one copy alone
// would reach only some sandboxes.
it('keeps the toolkit copy of verity-dev-server identical to the agent seed', async () => {
  const { readFileSync: read } = await import('node:fs');
  expect(
    read(resolve('features/verity-sandbox-toolkit/agent-seed/bin/verity-dev-server'), 'utf8'),
  ).toBe(read(resolve('agent-seed/bin/verity-dev-server'), 'utf8'));
});
