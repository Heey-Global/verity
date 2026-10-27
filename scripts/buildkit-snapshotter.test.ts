import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const script = resolve('deploy/buildkit/snapshotter-migrate.sh');
const available = spawnSync('sh', ['-c', 'command -v jq']).status === 0;
function fixture(
  options: {
    legacy?: boolean;
    busy?: boolean;
    failProbe?: boolean;
    crash?: boolean;
    failMount?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'snapshotter-'));
  roots.push(root);
  const config = join(root, 'config');
  const run = join(root, 'run');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const worker = join(root, 'worker');
  for (const dir of [config, run, state, bin, worker]) mkdirSync(dir);
  writeFileSync(join(run, 'buildkitd.sock'), '');
  writeFileSync(
    join(config, 'snapshotter-policy.conf'),
    readFileSync('deploy/buildkit/snapshotter-policy.conf'),
  );
  const previous =
    'root = "/var/lib/verity-buildkit"\n[worker.oci]\nsnapshotter = "native"\nbinary = "/usr/local/libexec/verity-buildkit/runsc"\n';
  writeFileSync(join(config, 'buildkitd.toml'), previous);
  writeFileSync(join(worker, 'protected-native-data'), 'keep');
  const tool = (name: string, body: string) =>
    writeFileSync(join(bin, name), '#!/usr/bin/env bash\nset -e\n' + body, { mode: 0o755 });
  tool(
    'docker',
    `if [[ $1 == ps ]]; then echo client; else printf '%s' '{"admission":"${options.legacy ? '0' : '1'}","mounts":[{"Source":"${run}","Destination":"/run/verity-buildkit","RW":true}]}'; fi\n`,
  );
  tool('df', 'printf "Avail\\n32212254720\\n"\n');
  tool('unshare', options.failMount ? 'exit 1\n' : 'exit 0\n');
  tool('systemctl', options.crash ? 'kill -KILL "$PPID"\n' : 'exit 0\n');
  tool(
    'buildctl',
    `shift 2
case "$1" in
 debug) snapshot=$(sed -nE 's/^snapshotter = "(.*)"/\\1/p' '${config}/buildkitd.toml'); printf '[{"labels":{"org.mobyproject.buildkit.worker.executor":"oci","org.mobyproject.buildkit.worker.network":"cni","org.mobyproject.buildkit.worker.oci.process-mode":"sandbox","org.mobyproject.buildkit.worker.snapshotter":"%s"}}]' "$snapshot" ;;
 du) echo '${options.busy ? '[{"inUse":true}]' : '[]'}' ;;
 build) ${options.failProbe ? 'exit 1' : 'exit 0'} ;;
esac\n`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    VERITY_BUILDKIT_CONFIG_DIR: config,
    VERITY_BUILDKIT_RUN_DIR: run,
    VERITY_SNAPSHOTTER_STATE: state,
    VERITY_BUILDKIT_LIBEXEC: bin,
    VERITY_BUILDKIT_STATE_ROOT: worker,
  };
  const invoke = (action = 'reconcile') =>
    spawnSync('bash', [script, action], { env, encoding: 'utf8', timeout: 10000 });
  const status = () =>
    JSON.parse(readFileSync(join(run, 'migration-status.json'), 'utf8')) as { state: string };
  return { invoke, status, config, state, root, run, previous, bin, worker };
}

(available ? describe : describe.skip)('release-owned snapshotter convergence', () => {
  it('switches once, validates the running worker and RUN, retaining native data', () => {
    const f = fixture();
    expect(f.invoke().status).toBe(0);
    expect(f.status().state).toBe('converged');
    expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toContain('"overlayfs"');
    expect(readFileSync(join(f.worker, 'protected-native-data'), 'utf8')).toBe('keep');
    expect(f.invoke().status).toBe(0);
    expect(existsSync(join(f.state, 'pending.json'))).toBe(false);
  });
  it.each([{ legacy: true }, { busy: true }])(
    'defers unknown clients or active work: %j',
    (options) => {
      const f = fixture(options);
      expect(f.invoke().status).toBe(0);
      expect(f.status().state).toBe('deferred');
      expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toBe(f.previous);
    },
  );
  it('preserves unresolved leases instead of treating a crashed Server as drained', () => {
    const f = fixture();
    expect(f.invoke('init').status).toBe(0);
    mkdirSync(join(f.run, 'leases', 'attempt-unknown'));
    expect(f.invoke().status).toBe(0);
    expect(f.status().state).toBe('deferred');
  });
  it('rolls back configuration when the gVisor build fails', () => {
    const f = fixture({ failProbe: true });
    expect(f.invoke().status).not.toBe(0);
    expect(f.status().state).toBe('rolled-back');
    expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toBe(f.previous);
    expect(existsSync(join(f.run, 'migration-pending'))).toBe(false);
    expect(f.invoke().status).toBe(0);
    expect(f.status().state).toBe('rolled-back');
    expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toBe(f.previous);
  });
  it('recovers a durable journal after a hard interruption', () => {
    const f = fixture({ crash: true });
    expect(f.invoke().signal).toBe('SIGKILL');
    expect(existsSync(join(f.state, 'pending.json'))).toBe(true);
    expect(f.invoke('recover').status).toBe(0);
    expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toBe(f.previous);
    expect(f.status().state).toBe('rolled-back');
  });
  it('changes nothing when the actual filesystem suitability check fails', () => {
    const f = fixture({ failMount: true });
    expect(f.invoke().status).not.toBe(0);
    expect(readFileSync(join(f.config, 'buildkitd.toml'), 'utf8')).toBe(f.previous);
    expect(existsSync(join(f.state, 'pending.json'))).toBe(false);
  });
});
