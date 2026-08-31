import { execFile, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// The wrapper lives at repo-root agent-seed/bin (mounted/baked into sandboxes).
// From packages/server/src that is three levels up.
const WRAPPER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../agent-seed/bin/verity-git-sign',
);

/** Whether every named executable is on this host's PATH. */
function hostHasTools(...tools: string[]): boolean {
  return tools.every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0,
  );
}

/** Run the wrapper under bash with the given args + env; capture exit + streams. */
async function runWrapper(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync('bash', [WRAPPER, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stderr: e.stderr ?? '' };
  }
}

/** A one-shot mock broker returning `body` with `status`; records the last request. */
function mockBroker(
  status: number,
  body: string,
): Promise<{
  server: Server;
  url: string;
  received: () => { auth: string | undefined; json: unknown };
}> {
  let last: { auth: string | undefined; json: unknown } = { auth: undefined, json: undefined };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      last = {
        auth: req.headers['authorization'],
        json: raw ? JSON.parse(raw) : undefined,
      };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, received: () => last });
    });
  });
}

let dir: string;
let broker: Server | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (broker) broker.close();
  broker = undefined;
});

// The wrapper is a shell script that genuinely shells out to curl and jq — its
// sandbox image ships both, and CI does too. A dev host that lacks them cannot
// exercise it at all: the wrapper's own missing-tool guard exits before any
// behaviour under test runs, which read as ten assertion failures rather than as
// "not runnable here". Skip explicitly instead, so a real regression stays visible
// everywhere the tools exist.
const describeWrapper = hostHasTools('curl', 'jq') ? describe : describe.skip;

describeWrapper('verity-git-sign wrapper (commit-signing broker)', () => {
  it('forwards -Y sign to the broker and writes the returned signature to <datafile>.sig', async () => {
    const signature =
      '-----BEGIN SSH SIGNATURE-----\nU1NIU0lH-broker\n-----END SSH SIGNATURE-----\n';
    const mock = await mockBroker(200, JSON.stringify({ signature }));
    broker = mock.server;
    dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const datafile = join(dir, 'commit-buffer');
    const tokenFile = join(dir, 'signing_broker_token');
    writeFileSync(datafile, 'the commit payload\n');
    writeFileSync(tokenFile, 'broker-token-abc\n');

    const { code } = await runWrapper(['-Y', 'sign', '-n', 'git', '-f', '/dev/null', datafile], {
      VERITY_SIGNING_URL: mock.url,
      VERITY_SIGNING_TOKEN_FILE: tokenFile,
    });

    expect(code).toBe(0);
    expect(readFileSync(`${datafile}.sig`, 'utf8')).toBe(signature);
    // It authenticated with the broker token and sent the base64 of the buffer.
    const req = mock.received();
    expect(req.auth).toBe('Bearer broker-token-abc');
    const body = req.json as { namespace: string; payload: string };
    expect(body.namespace).toBe('git');
    expect(Buffer.from(body.payload, 'base64').toString()).toBe('the commit payload\n');
  });

  it('exits non-zero and writes no .sig when the broker rejects the request', async () => {
    const mock = await mockBroker(500, JSON.stringify({ error: 'boom' }));
    broker = mock.server;
    dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const datafile = join(dir, 'commit-buffer');
    const tokenFile = join(dir, 'signing_broker_token');
    writeFileSync(datafile, 'payload\n');
    writeFileSync(tokenFile, 'broker-token-abc\n');

    const { code } = await runWrapper(['-Y', 'sign', '-n', 'git', '-f', '/dev/null', datafile], {
      VERITY_SIGNING_URL: mock.url,
      VERITY_SIGNING_TOKEN_FILE: tokenFile,
    });

    expect(code).not.toBe(0);
    expect(existsSync(`${datafile}.sig`)).toBe(false);
  });

  it('fails before contacting the broker when the token file is missing', async () => {
    const mock = await mockBroker(200, JSON.stringify({ signature: 'unused' }));
    broker = mock.server;
    dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const datafile = join(dir, 'commit-buffer');
    writeFileSync(datafile, 'payload\n');

    const { code, stderr } = await runWrapper(
      ['-Y', 'sign', '-n', 'git', '-f', '/dev/null', datafile],
      {
        VERITY_SIGNING_URL: mock.url,
        VERITY_SIGNING_TOKEN_FILE: join(dir, 'missing-token'),
      },
    );

    expect(code).not.toBe(0);
    expect(stderr).toContain('signing token file is not readable');
    expect(mock.received().auth).toBeUndefined();
    expect(existsSync(`${datafile}.sig`)).toBe(false);
  });

  it('is transparent without broker env: -Y sign delegates to the real ssh-keygen', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wrap-'));
    const key = join(dir, 'id_ed25519');
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
    const datafile = join(dir, 'commit-buffer');
    writeFileSync(datafile, 'payload\n');

    // No VERITY_SIGNING_URL → the wrapper must `exec ssh-keygen` and produce a real
    // armored signature, identical behavior to invoking ssh-keygen directly.
    const { code } = await runWrapper(['-Y', 'sign', '-n', 'git', '-f', key, datafile], {
      VERITY_SIGNING_URL: '',
    });

    expect(code).toBe(0);
    const sig = readFileSync(`${datafile}.sig`, 'utf8');
    expect(sig).toContain('BEGIN SSH SIGNATURE');
  });

  // The docker fallback itself needs a live daemon, so guard the one property that
  // silently broke it instead: it must address the agent by NUMERIC uid. The agent
  // user's NAME comes from the project's own devcontainer.json `remoteUser`, so it
  // is `vscode` on the common base images, `node` on others, and `dev` only on
  // verity-sandbox. A hardcoded `--user dev` made both wrappers die with "unable to
  // find user dev" on every neutral-path container. Verity owns the uid, not the
  // name. Both seed copies are shipped (repo root + the toolkit Feature), so both
  // are checked.
  it('addresses the agent by numeric uid in the docker fallback, never by name', () => {
    const seedRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
    const wrappers = [
      'agent-seed/bin/verity-git-sign',
      'agent-seed/bin/verity-gh-token',
      'features/verity-sandbox-toolkit/agent-seed/bin/verity-git-sign',
      'features/verity-sandbox-toolkit/agent-seed/bin/verity-gh-token',
    ];
    for (const rel of wrappers) {
      const source = readFileSync(join(seedRoot, rel), 'utf8');
      expect(source, rel).toContain('docker exec --user "${VERITY_AGENT_UID:-1000}"');
      expect(source, rel).not.toContain('--user dev');
    }
  });
});
