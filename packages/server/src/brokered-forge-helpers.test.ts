import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const roots = ['agent-seed/bin', 'features/verity-sandbox-toolkit/agent-seed/bin'];
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
);

async function fixture(seed: string) {
  const dir = await mkdtemp(join(tmpdir(), 'verity-forge-helper-'));
  dirs.push(dir);
  await writeFile(join(dir, 'cap'), 'c'.repeat(43));
  await writeFile(join(dir, 'ca'), 'public-ca-fixture');
  await writeFile(
    join(dir, 'gh-real'),
    '#!/usr/bin/env bash\nprintf "%s\\n%s\\n%s" "$GH_TOKEN" "$HTTPS_PROXY" "$SSL_CERT_FILE"',
    { mode: 0o755 },
  );
  return {
    dir,
    env: {
      ...process.env,
      PATH: `${resolve(seed)}:${process.env.PATH ?? ''}`,
      VERITY_GH_REAL: join(dir, 'gh-real'),
      VERITY_FORGE_MODE: 'proxy-test',
      VERITY_FORGE_PROXY_URL: 'http://relay:8080',
      VERITY_FORGE_PROXY_CA_FILE: join(dir, 'ca'),
      VERITY_GH_BROKER_CAPABILITY_FILE: join(dir, 'cap'),
      VERITY_GH_TOKEN_URL: 'http://127.0.0.1:1/legacy',
      VERITY_GH_TOKEN_DOCKER_CONTAINER: 'legacy-container',
      GH_TOKEN: 'stale-github-token',
      GITHUB_TOKEN: 'stale-github-token',
    },
  };
}

describe.each(roots)('%s forge test mode', (seed) => {
  it('returns a capability placeholder and replaces inherited gh credentials', async () => {
    const { dir, env } = await fixture(seed);
    const cap = (await readFile(join(dir, 'cap'), 'utf8')).trim();
    expect((await exec(join(seed, 'verity-gh-token'), [], { env })).stdout).toBe(
      `verity-broker-${cap}`,
    );
    const result = await exec(join(seed, 'gh'), ['api', 'repos/acme/app'], { env });
    expect(result.stdout.split('\n')).toEqual([
      `verity-broker-${cap}`,
      env.VERITY_FORGE_PROXY_URL,
      env.VERITY_FORGE_PROXY_CA_FILE,
    ]);
    expect(result.stdout).not.toContain('stale-github-token');
  });
  it('fails closed with missing configuration rather than executing legacy helpers or gh', async () => {
    const { dir, env } = await fixture(seed);
    const invocationLog = join(dir, 'unexpected-fallback');
    await writeFile(
      join(dir, 'curl'),
      `#!/usr/bin/env bash\necho curl >> "$VERITY_TEST_FALLBACK_LOG"\nprintf '{"token":"legacy-token"}'\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, 'docker'),
      '#!/usr/bin/env bash\necho docker >> "$VERITY_TEST_FALLBACK_LOG"\nprintf legacy-token\n',
      { mode: 0o755 },
    );
    env.PATH = `${dir}:${env.PATH}`;
    for (const override of [
      { VERITY_GH_BROKER_CAPABILITY_FILE: '/nonexistent' },
      { VERITY_FORGE_PROXY_CA_FILE: '/nonexistent' },
      { VERITY_FORGE_PROXY_URL: '' },
      { VERITY_FORGE_MODE: 'unknown' },
    ]) {
      await expect(
        exec(join(seed, 'verity-gh-token'), [], {
          env: { ...env, VERITY_TEST_FALLBACK_LOG: invocationLog, ...override },
        }),
      ).rejects.toThrow();
      await expect(
        exec(join(seed, 'gh'), [], {
          env: { ...env, VERITY_TEST_FALLBACK_LOG: invocationLog, ...override },
        }),
      ).rejects.toThrow();
    }
    await expect(readFile(invocationLog)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains explicit legacy token redemption when the test mode is absent', async () => {
    const { env } = await fixture(seed);
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.setHeader('content-type', 'application/json');
      response.end('{"token":"legacy-token"}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as { port: number }).port;
      expect(
        (
          await exec(join(seed, 'verity-gh-token'), [], {
            env: {
              ...env,
              VERITY_FORGE_MODE: '',
              VERITY_GH_TOKEN_URL: `http://127.0.0.1:${port}/legacy`,
            },
          })
        ).stdout,
      ).toBe('legacy-token');
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
