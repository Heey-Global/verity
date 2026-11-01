import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const hasTools = ['jq', 'flock', 'sha512sum'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-service-install-'));
  roots.push(root);
  for (const dir of ['state', 'private', 'libexec', 'units', 'run', 'bin'])
    mkdirSync(join(root, dir));
  chmodSync(join(root, 'private'), 0o700);
  const old = '#!/bin/sh\necho old-runtime\n';
  writeFileSync(join(root, 'libexec/verity-host-runtime'), old, { mode: 0o750 });
  for (const unit of ['service', 'path'])
    writeFileSync(join(root, `units/verity-host-runtime.${unit}`), `old-${unit}\n`);
  writeFileSync(
    join(root, 'state/agent.json'),
    JSON.stringify({
      version: 1,
      trigger: 'systemd-path',
      builder: 'systemd-path',
      runtimeArtifacts: ['binary'],
    }),
  );
  const initialAgent = readFileSync(join(root, 'state/agent.json'), 'utf8');
  for (const marker of ['active', 'enabled']) writeFileSync(join(root, marker), '');
  writeFileSync(
    join(root, 'bin/systemctl'),
    `#!/bin/bash
set -eu
printf '%s\\n' "$*" >>'${root}/calls'
case "$1" in
  is-active) [[ \${3:-} == verity-host-runtime.path && -e '${root}/active' ]] ;;
  is-enabled) [[ -e '${root}/enabled' ]] ;;
  stop) rm -f '${root}/active' ;;
  start) touch '${root}/active' ;;
  disable) rm -f '${root}/enabled' ;;
  enable) touch '${root}/enabled'; if [[ \${2:-} == --now ]]; then touch '${root}/active'; fi ;;
  show) echo loaded ;;
  daemon-reload)
    if [[ -e '${root}/crash' ]]; then rm '${root}/crash'; kill -KILL "$PPID"; exit 1; fi
    if [[ -e '${root}/fail' ]]; then rm '${root}/fail'; exit 1; fi ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    VERITY_HOST_RUNTIME_TEST: '1',
    VERITY_HOST_RUNTIME_DIR: `${root}/state`,
    VERITY_HOST_RUNTIME_PRIVATE_DIR: `${root}/private`,
    VERITY_HOST_RUNTIME_LIBEXEC: `${root}/libexec`,
    VERITY_SYSTEMD_UNIT_DIR: `${root}/units`,
    VERITY_SYSTEMD_RUN_DIR: `${root}/run`,
    VERITY_RENEW_DEPLOYMENT: 'deployment-1',
    VERITY_RENEW_ID: 'update-1',
    VERITY_RENEW_IMAGE: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
  };
  const run = () =>
    spawnSync('bash', [resolve('deploy/host/install-runtime-service.sh')], {
      env,
      encoding: 'utf8',
    });
  return { root, old, initialAgent, run };
}

describe.skipIf(!hasTools)('runtime-only service installation transaction', () => {
  it('renews an old service without touching the builder and publishes matching capabilities last', () => {
    const h = fixture();
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    const agent = JSON.parse(readFileSync(`${h.root}/state/agent.json`, 'utf8'));
    const installed = readFileSync(`${h.root}/libexec/verity-host-runtime`);
    expect(agent).toMatchObject({
      version: 1,
      trigger: 'systemd-path',
      builder: 'systemd-path',
      runtimeArtifacts: ['binary', 'archive'],
      runtimeService: {
        revision: 1,
        renewalProtocol: 1,
        sha512: createHash('sha512').update(installed).digest('hex'),
        receipt: {
          updateId: 'update-1',
          deploymentId: 'deployment-1',
          targetDigest: expect.stringContaining('@sha256:'),
        },
      },
    });
    expect(readFileSync(`${h.root}/calls`, 'utf8')).not.toMatch(/restart|builder|docker/);
    expect(existsSync(`${h.root}/private/service-install`)).toBe(false);
    expect(h.run().status).toBe(0);
  }, 60_000);
  it('restores script, units, watcher state and agent when publication fails', () => {
    const h = fixture();
    writeFileSync(`${h.root}/fail`, '');
    const result = h.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('previous service restored');
    expect(readFileSync(`${h.root}/libexec/verity-host-runtime`, 'utf8')).toBe(h.old);
    expect(readFileSync(`${h.root}/units/verity-host-runtime.service`, 'utf8')).toBe(
      'old-service\n',
    );
    expect(readFileSync(`${h.root}/state/agent.json`, 'utf8')).toBe(h.initialAgent);
    expect(existsSync(`${h.root}/active`)).toBe(true);
    expect(existsSync(`${h.root}/enabled`)).toBe(true);
    expect(h.run().status).toBe(0);
  }, 60_000);
  it('recovers an interrupted publication before a retry takes another backup', () => {
    const h = fixture();
    writeFileSync(`${h.root}/crash`, '');
    expect(h.run().signal).toBe('SIGKILL');
    expect(existsSync(`${h.root}/private/service-install/pending`)).toBe(true);
    expect(readFileSync(`${h.root}/state/agent.json`, 'utf8')).toBe(h.initialAgent);
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(`${h.root}/private/service-install`)).toBe(false);
  }, 60_000);
  it('rejects symlinked destinations before mutating any service', () => {
    const h = fixture();
    rmSync(`${h.root}/state/agent.json`);
    symlinkSync(`${h.root}/libexec/verity-host-runtime`, `${h.root}/state/agent.json`);
    expect(h.run().status).not.toBe(0);
    expect(readFileSync(`${h.root}/libexec/verity-host-runtime`, 'utf8')).toBe(h.old);
    expect(existsSync(`${h.root}/calls`)).toBe(false);
  }, 60_000);
  it('retains a recoverable checkpoint when rollback cannot be verified', () => {
    const h = fixture();
    writeFileSync(`${h.root}/bin/systemctl`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = h.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('recovery-required');
    expect(existsSync(`${h.root}/private/service-install/pending`)).toBe(true);
  }, 60_000);
});

describe.skipIf(!hasTools)('runtime service lock coordination', () => {
  it('waits for an existing runtime transaction before replacing the service', async () => {
    const h = fixture();
    const locked = spawn('flock', [
      `${h.root}/private/lock`,
      'bash',
      '-c',
      `touch '${h.root}/locked'; sleep 1; grep -q old-runtime '${h.root}/libexec/verity-host-runtime' && touch '${h.root}/preserved'`,
    ]);
    try {
      while (!existsSync(`${h.root}/locked`))
        await new Promise((resolve) => setTimeout(resolve, 10));
      const result = h.run();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(`${h.root}/preserved`)).toBe(true);
    } finally {
      locked.kill();
    }
  }, 60_000);
});
