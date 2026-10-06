import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hostDiagnosticSnapshotSchema } from '../packages/server/src/runtime-diagnostics.js';

const script = resolve('deploy/host/verity-host-diagnostics');
const hasTools = ['jq', 'timeout'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const describeHost = hasTools ? describe : describe.skip;
function collect(options: { failRuntime?: boolean; many?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-host-diagnostics-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const state = join(root, 'state');
  writeFileSync(
    join(bin, 'journalctl'),
    `#!/usr/bin/env node
const kernel = process.argv.includes('_TRANSPORT=kernel');
if (!kernel && process.env.TEST_FAIL_RUNTIME === '1') process.exit(1);
const message = kernel ? 'Killed process 123 (private-name), docker-${'a'.repeat(64)}.scope credential' : 'containerManager.WaitPID failed EOF credential';
const row = JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.now() * 1000), MESSAGE: message });
const count = process.env.TEST_MANY === '1' ? 2001 : 1;
for (let index = 0; index < count; index++) process.stdout.write(row + '\\n');
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VERITY_HOST_DIAGNOSTIC_DIR: state,
      TEST_FAIL_RUNTIME: options.failRuntime ? '1' : '0',
      TEST_MANY: options.many ? '1' : '0',
    },
    encoding: 'utf8',
  });
  return { root, state, result };
}
describeHost('host diagnostic exporter', () => {
  it('publishes classified evidence atomically without raw journal fields or credentials', () => {
    const host = collect();
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const raw = readFileSync(join(host.state, 'snapshot.json'), 'utf8');
      const snapshot = hostDiagnosticSnapshotSchema.parse(JSON.parse(raw));
      expect(snapshot.sources).toEqual({ kernel: 'available', runtime: 'available' });
      expect(snapshot.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'kernel',
            code: 'oom_kill',
            containerId: 'a'.repeat(64),
          }),
          expect.objectContaining({ source: 'runtime', code: 'runtime_disconnect' }),
        ]),
      );
      expect(raw).not.toMatch(/credential|private-name|MESSAGE|__REALTIME_TIMESTAMP/u);
      expect(statSync(join(host.state, 'snapshot.json')).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('preserves healthy evidence when one journal source fails', () => {
    const host = collect({ failRuntime: true });
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const snapshot = hostDiagnosticSnapshotSchema.parse(
        JSON.parse(readFileSync(join(host.state, 'snapshot.json'), 'utf8')),
      );
      expect(snapshot.sources).toEqual({ kernel: 'available', runtime: 'failed' });
      expect(snapshot.records).toHaveLength(1);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('marks journal and record truncation instead of presenting bounded output as complete history', () => {
    const host = collect({ many: true });
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const snapshot = hostDiagnosticSnapshotSchema.parse(
        JSON.parse(readFileSync(join(host.state, 'snapshot.json'), 'utf8')),
      );
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.records).toHaveLength(400);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
});

it('wires the actual exporter into installation, its timer and a read-only Server mount', () => {
  const service = readFileSync('deploy/host/verity-host-diagnostics.service', 'utf8');
  const executable = /^ExecStart=.*\/([^/\n]+)$/mu.exec(service)?.[1];
  expect(executable).toBeDefined();
  expect(readFileSync(`deploy/host/${executable}`, 'utf8')).toContain('journalctl');
  const installer = readFileSync('deploy/bin/verity-install', 'utf8');
  expect(installer).toContain(`deploy/host/${executable}`);
  expect(installer).toContain('systemctl enable --now verity-host-diagnostics.timer');
  const timer = readFileSync('deploy/host/verity-host-diagnostics.timer', 'utf8');
  expect(timer).toContain('OnUnitActiveSec=1min');
  const compose = parse(readFileSync('deploy/docker-compose.yml', 'utf8')) as {
    services: Record<string, { volumes?: unknown[] }>;
  };
  const mounts =
    compose.services.verity?.volumes?.filter(
      (value): value is string => typeof value === 'string',
    ) ?? [];
  expect(mounts.some((mount) => mount.endsWith(':/run/verity-host-diagnostics:ro'))).toBe(true);
  for (const [service, config] of Object.entries(compose.services)) {
    if (service === 'verity') continue;
    expect(JSON.stringify(config.volumes ?? [])).not.toContain('/run/verity-host-diagnostics');
  }
  expect(readFileSync('packages/server/src/server-main.ts', 'utf8')).toContain(
    '/run/verity-host-diagnostics/snapshot.json',
  );
});
