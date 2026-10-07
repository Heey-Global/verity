import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hostDiagnosticSnapshotSchema } from '../packages/server/src/runtime-diagnostics.js';
import { readHostDiagnosticsCapability } from '../packages/server/src/self-update/host-diagnostics.js';

const script = resolve(
  process.env.VERITY_TEST_HOST_DIAGNOSTICS_EXPORTER ?? 'deploy/host/verity-host-diagnostics',
);
const hasTools = ['jq', 'timeout', 'flock'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const describeHost = hasTools ? describe : describe.skip;
function collect(
  options: { failRuntime?: boolean; many?: boolean; bytes?: boolean; events?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'verity-host-diagnostics-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const state = join(root, 'state');
  const runtime = join(root, 'runtime');
  mkdirSync(runtime);
  writeFileSync(
    join(bin, 'journalctl'),
    `#!/usr/bin/env node
const kernel = process.argv.includes('_TRANSPORT=kernel');
if (!kernel && process.env.TEST_FAIL_RUNTIME === '1') process.exit(1);
const message = kernel ? 'Killed process 123 (private-name), docker-${'a'.repeat(64)}.scope credential' : 'containerManager.WaitPID failed EOF credential';
const row = (index) => JSON.stringify({ __REALTIME_TIMESTAMP: String((Date.now() - 5000 - index * 1000) * 1000), MESSAGE: message });
const count = process.env.TEST_MANY === '1' ? 2001 : 1;
for (let index = 0; index < count; index++) process.stdout.write(row(index) + '\\n');
if (process.env.TEST_BYTES === '1') process.stdout.write(JSON.stringify({__REALTIME_TIMESTAMP: String((Date.now() - 5000) * 1000), MESSAGE: 'x'.repeat(1048576)}) + '\\n');
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
if (process.env.TEST_EVENTS !== '1') process.exit(1);
for (const [Action, Attributes] of [['die', {exitCode:'137', secret:'credential'}], ['kill', {signal:'9'}], ['oom', {}]]) {
  console.log(JSON.stringify({Type:'container', Action, time:Math.floor(Date.now()/1000)-5, Actor:{ID:'${'b'.repeat(64)}', Attributes}}));
}
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VERITY_HOST_DIAGNOSTIC_DIR: state,
      VERITY_HOST_RUNTIME_DIR: runtime,
      TEST_FAIL_RUNTIME: options.failRuntime ? '1' : '0',
      TEST_MANY: options.many ? '1' : '0',
      TEST_BYTES: options.bytes ? '1' : '0',
      TEST_EVENTS: options.events ? '1' : '0',
    },
    encoding: 'utf8',
  });
  return { root, state, runtime, result };
}
describeHost('host diagnostic exporter', () => {
  it('retains sanitized exit evidence when Docker history disappears and expires old records', () => {
    const host = collect({ events: true });
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const path = join(host.state, 'snapshot.json');
      const first = hostDiagnosticSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(first.sources.docker).toBe('available');
      expect(first.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'docker', code: 'die', exitCode: 137 }),
          expect.objectContaining({ source: 'docker', code: 'kill', signal: 9 }),
          expect.objectContaining({ source: 'docker', code: 'oom' }),
        ]),
      );
      expect(readFileSync(path, 'utf8')).not.toMatch(/secret|credential|Attributes/u);
      first.truncatedUntil = '2000-01-02T00:00:00Z';
      first.truncated = true;
      first.records.push({
        at: '2000-01-01T00:00:00Z',
        source: 'docker',
        code: 'die',
        containerId: 'c'.repeat(64),
        exitCode: 0,
      });
      writeFileSync(path, JSON.stringify(first));
      // No new lifecycle facts survive the daemon's empty historical response.
      writeFileSync(join(host.root, 'bin', 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const run = () =>
        spawnSync('bash', [script], {
          env: {
            ...process.env,
            PATH: `${join(host.root, 'bin')}:${process.env.PATH}`,
            VERITY_HOST_DIAGNOSTIC_DIR: host.state,
          },
          encoding: 'utf8',
        });
      for (let index = 0; index < 2; index++) {
        const result = run();
        expect(result.status, result.stderr).toBe(0);
        const next = hostDiagnosticSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        expect(next.truncated).toBe(false);
        expect(next.truncatedUntil).toBeUndefined();
        expect(next.records.filter((record) => record.source === 'docker')).toEqual(
          first.records.filter(
            (record) => record.source === 'docker' && record.containerId !== 'c'.repeat(64),
          ),
        );
      }
      writeFileSync(join(host.root, 'bin', 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      expect(run().status).toBe(0);
      const failed = hostDiagnosticSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(failed.sources.docker).toBe('failed');
      expect(failed.records.filter((record) => record.source === 'docker')).toHaveLength(3);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('advances past overflowing history so old events cannot starve new exits', () => {
    const host = collect({ events: true });
    try {
      const path = join(host.state, 'snapshot.json');
      const initial = JSON.parse(readFileSync(path, 'utf8'));
      delete initial.dockerUntil;
      writeFileSync(path, JSON.stringify(initial));
      writeFileSync(
        join(host.root, 'bin', 'docker'),
        `#!/usr/bin/env node
const since=Date.parse(process.argv[process.argv.indexOf('--since')+1]);
if (Date.now()-since > 120000) {
  console.log(JSON.stringify({Type:'container',Action:'start',time:Math.floor(Date.now()/1000)-120,Actor:{ID:'${'d'.repeat(64)}',Attributes:{private:'x'.repeat(270000)}}}));
} else {
  console.log(JSON.stringify({Type:'container',Action:'die',time:Math.floor(Date.now()/1000)-5,Actor:{ID:'${'e'.repeat(64)}',Attributes:{exitCode:'137'}}}));
}
`,
        { mode: 0o755 },
      );
      const run = () =>
        spawnSync('bash', [script], {
          env: {
            ...process.env,
            PATH: `${join(host.root, 'bin')}:${process.env.PATH}`,
            VERITY_HOST_DIAGNOSTIC_DIR: host.state,
          },
          encoding: 'utf8',
        });
      const capped = run();
      expect(capped.status, capped.stderr).toBe(0);
      const snapshot = hostDiagnosticSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.truncatedUntil).toBeDefined();
      expect(snapshot.dockerUntil).toBe(snapshot.until);
      const next = run();
      expect(next.status, next.stderr).toBe(0);
      const refreshed = hostDiagnosticSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      expect(refreshed.records).toContainEqual(
        expect.objectContaining({
          source: 'docker',
          code: 'die',
          containerId: 'e'.repeat(64),
          exitCode: 137,
        }),
      );
      expect(refreshed.truncatedUntil).toBe(snapshot.truncatedUntil);
      expect(readFileSync(path, 'utf8')).not.toContain('private');
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('leaves the atomic snapshot untouched while another collection holds the lock', () => {
    const host = collect({ events: true });
    try {
      const path = join(host.state, 'snapshot.json');
      const before = readFileSync(path, 'utf8');
      const result = spawnSync(
        'flock',
        ['--exclusive', join(host.state, '.collector.lock'), 'bash', script],
        { env: { ...process.env, VERITY_HOST_DIAGNOSTIC_DIR: host.state }, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('publishes a mount capability matching the actual classified snapshot', async () => {
    const host = collect({ failRuntime: true });
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const snapshot = hostDiagnosticSnapshotSchema.parse(
        JSON.parse(readFileSync(join(host.state, 'snapshot.json'), 'utf8')),
      );
      const { records, ...metadata } = snapshot;
      expect(records).toHaveLength(1);
      expect(await readHostDiagnosticsCapability(host.runtime)).toEqual({
        state: 'available',
        hostPath: host.state,
        snapshot: metadata,
      });
      expect(readFileSync(join(host.runtime, 'diagnostics.json'), 'utf8')).not.toContain('records');
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });
  it('retains complete incident entries when a byte cap cuts through a large journal entry', () => {
    const host = collect({ bytes: true });
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const snapshot = hostDiagnosticSnapshotSchema.parse(
        JSON.parse(readFileSync(join(host.state, 'snapshot.json'), 'utf8')),
      );
      expect(snapshot.sources).toEqual({
        kernel: 'available',
        runtime: 'available',
        docker: 'failed',
      });
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.records).toHaveLength(2);
    } finally {
      rmSync(host.root, { recursive: true, force: true });
    }
  });

  it('publishes classified evidence atomically without raw journal fields or credentials', () => {
    const host = collect();
    try {
      expect(host.result.status, host.result.stderr).toBe(0);
      const raw = readFileSync(join(host.state, 'snapshot.json'), 'utf8');
      const snapshot = hostDiagnosticSnapshotSchema.parse(JSON.parse(raw));
      expect(snapshot.sources).toEqual({
        kernel: 'available',
        runtime: 'available',
        docker: 'failed',
      });
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
      expect(snapshot.sources).toEqual({
        kernel: 'available',
        runtime: 'failed',
        docker: 'failed',
      });
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
