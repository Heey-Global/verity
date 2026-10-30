import { nativeRetirementSchema } from '@verity/events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const available = spawnSync('sh', ['-c', 'command -v jq']).status === 0;
function fixture(options: { reserved?: boolean; stale?: boolean; busy?: boolean; mount?: boolean; unknown?: boolean; crash?: boolean; failProbe?: boolean; stopped?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-retirement-')); roots.push(dir);
  const root = join(dir, 'buildkit'), state = join(dir, 'state'), run = join(dir, 'run'), bin = join(dir, 'bin');
  for (const path of [root, state, run, bin, join(run, 'leases'), join(run, 'reclamation-evidence'), join(root, 'runc-native'), join(root, 'runc-overlayfs')]) mkdirSync(path);
  writeFileSync(join(run, 'build-admission.lock'), '');
  writeFileSync(join(root, 'runc-native', 'old'), 'native snapshot');
  writeFileSync(join(root, 'runc-overlayfs', 'active'), 'keep overlay');
  writeFileSync(join(root, 'cache.db'), 'keep shared metadata');
  // Map only the production root literal into this disposable fixture; all path,
  // mount and transaction checks run from the actual release helper.
  const helper = join(dir, 'native-retire.sh');
  writeFileSync(helper, readFileSync(resolve('deploy/buildkit/native-retire.sh'), 'utf8').replaceAll('/var/lib/verity-buildkit', root));
  const tool = (name: string, source: string) => writeFileSync(join(bin, name), '#!/usr/bin/env bash\nset -euo pipefail\n' + source, { mode: 0o755 });
  tool('docker', `if [[ $1 == ps ]]; then echo server; else echo '{"mounts":[{"Source":"${run}"}],"identity":"server","running":${!options.stopped}}'; fi\n`);
  tool('findmnt', `echo '{"filesystems":[{"target":"${options.mount ? join(root, 'runc-native', 'nested') : '/'}"}]}'\n`);
  tool('sleep', `jq '. + {identity:"server",empty:${!options.reserved}} ${options.stale ? '| .nonce = "stale"' : ''}' '${run}/native-challenge.json' > '${run}/reclamation-evidence/server.json'\n`);
  tool('systemctl', `echo "$*" >> '${dir}/systemctl.log'\n${options.crash ? `if [[ $1 == stop && ! -e '${dir}/crashed' ]]; then touch '${dir}/crashed'; kill -KILL "$PPID"; fi` : ''}\n`);
  const wrapper = join(dir, 'invoke.sh');
  writeFileSync(wrapper, `set -euo pipefail\nroot='${root}'\nstate='${state}'\nrun_dir='${run}'\njournal='${state}/pending.json'\nselected() { echo overlayfs; }\nworker() { echo overlayfs; }\nclients_compatible() { ${options.unknown ? 'return 1' : 'return 0'}; }\nctl() { echo '${options.busy ? '[{"inUse":true}]' : '[]'}'; }\nprobe() { if flock --shared --nonblock '${run}/build-admission.lock' true; then return 1; fi; [[ ! -e '${dir}/fail-probe' ]]; }\nsource '${helper}'\nnative_retire\n`);
  if (options.failProbe) writeFileSync(join(dir, 'fail-probe'), '');
  const invoke = () => spawnSync('bash', [wrapper], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  const report = () => nativeRetirementSchema.parse(JSON.parse(readFileSync(join(run, 'native-retirement.json'), 'utf8')));
  return { dir, root, state, run, invoke, report };
}
(available ? describe : describe.skip)('native BuildKit retirement', () => {
  it('retires only native data after overlay verification, preserving shared metadata', () => {
    const f = fixture(); const result = f.invoke(); expect(result.stderr, result.error?.message).not.toContain('failed'); expect(result.status).toBe(0);
    expect(existsSync(join(f.root, 'runc-native'))).toBe(false);
    expect(readFileSync(join(f.root, 'cache.db'), 'utf8')).toBe('keep shared metadata');
    expect(readFileSync(join(f.root, 'runc-overlayfs', 'active'), 'utf8')).toBe('keep overlay');
    expect(f.report()).toMatchObject({ state: 'completed', dryRun: false, blockers: [] });
    expect(f.report().allocatedBytes).toBeGreaterThan(0);
    expect(existsSync(join(f.run, 'migration-pending'))).toBe(false);
    const completedAt = f.report().observedAt;
    const overlayBytes = f.report().overlayAllocatedBytes;
    if (overlayBytes === null) throw new Error('Expected measured overlay allocation');
    writeFileSync(join(f.root, 'runc-overlayfs', 'new-allocation'), Buffer.alloc(65536));
    expect(f.invoke().status).toBe(0);
    expect(f.report().observedAt >= completedAt).toBe(true);
    expect(f.report().lastCompletedAt).toBe(completedAt);
    expect(f.report().overlayAllocatedBytes).toBeGreaterThan(overlayBytes);
  });
  it.each([
    [{ reserved: true }, 'persistent-reservations-not-proven-empty'],
    [{ stale: true }, 'persistent-reservations-not-proven-empty'],
    [{ busy: true }, 'builder-activity-not-excluded'],
    [{ mount: true }, 'native-state-is-mounted'],
    [{ unknown: true }, 'unknown-builder-consumers'],
    [{ stopped: true }, 'stopped-builder-consumer-needs-reservation-evidence'],
  ] as const)('retains uncertain state: %j', (options, reason) => {
    const f = fixture(options); expect(f.invoke().status).toBe(0);
    expect(f.report().blockers).toContain(reason);
    expect(existsSync(join(f.root, 'runc-native', 'old'))).toBe(true);
    expect(existsSync(join(f.dir, 'systemctl.log'))).toBe(false);
  });
  it('rejects native symlinks and retained runtime leases', () => {
    const f = fixture(); rmSync(join(f.root, 'runc-native'), { recursive: true });
    symlinkSync(join(f.root, 'runc-overlayfs'), join(f.root, 'runc-native'));
    mkdirSync(join(f.run, 'leases', 'attempt-unknown'));
    expect(f.invoke().status).toBe(0);
    expect(f.report().blockers).toContain('unsupported-or-symlinked-state-root');
    expect(f.report().blockers).toContain('unresolved-runtime-leases');
  });
  it.each([{ failProbe: true }, { crash: true }])('recovers interruption without discarding the journal: %j', options => {
    const f = fixture(options); expect(f.invoke().status).not.toBe(0);
    expect(existsSync(join(f.state, 'native-retirement.json'))).toBe(true);
    expect(existsSync(join(f.run, 'migration-pending'))).toBe(true);
    if (options.failProbe) rmSync(join(f.dir, 'fail-probe'));
    expect(f.invoke().status).toBe(0);
    expect(f.report().state).toBe('completed');
    expect(existsSync(join(f.state, 'native-retired'))).toBe(true);
  });
});
