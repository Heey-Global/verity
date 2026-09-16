import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const script = resolve('deploy/bin/verity-managed-install-smoke');

describe('managed installer acceptance isolation', () => {
  it('is valid shell', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
  });

  it.each(['host', 'inside', 'occupied'] as const)(
    'refuses %s daemon evidence before cleanup or installation',
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), 'verity-managed-install-dind-'));
      const socket = join(root, 'docker.sock');
      const log = join(root, 'calls');
      const server = createServer();
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(socket, resolveListen);
      });
      try {
        // Only read-only discovery commands are implemented. Any mutation means
        // the refusal crossed the cleanup boundary it was supposed to protect.
        const docker = join(root, 'docker');
        await writeFile(
          docker,
          `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$SMOKE_CALLS"
case "$*" in
  *'exec --env '*'docker info'*) printf '%s\\n' '${failure === 'inside' ? 'other-daemon' : failure === 'host' ? 'host-daemon' : 'isolated'}' ;;
  '--host unix:///var/run/docker.sock info '*) printf '%s\\n' 'host-daemon' ;;
  *' info '*) printf '%s\\n' '${failure === 'host' ? 'host-daemon' : 'isolated'}' ;;
  *' ps -aq') printf '%s' '${failure === 'occupied' ? 'existing-container' : ''}' ;;
  *) echo 'unexpected docker operation' >&2; exit 73 ;;
esac
`,
        );
        await chmod(docker, 0o755);
        const result = await run(
          'bash',
          [script, 'candidate', 'verity-managed-install-dind-test'],
          {
            env: {
              ...process.env,
              PATH: `${root}:${process.env.PATH ?? ''}`,
              DOCKER_HOST: `unix://${socket}`,
              VERITY_MANAGED_INSTALL_DAEMON_ID: failure === 'host' ? 'host-daemon' : 'isolated',
              SMOKE_CALLS: log,
            },
          },
        ).then(
          () => ({ code: 0, stderr: '' }),
          (error: { code: number; stderr: string }) => error,
        );
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain('refuses to run');
        const calls = await readFile(log, 'utf8');
        expect(calls).not.toMatch(/(?:^|\s)(rm|run|create|pull|push|volume|network)(?:\s|$)/);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
