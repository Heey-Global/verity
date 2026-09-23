import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/host/verity-host-runtime is the one root process that edits the host's Docker
// configuration for Verity. What must hold: it changes exactly the two runtime entries, keeps
// everything else, never runs containers through a restart, leaves the host as it was when any
// step fails, and can be re-run from any point it was interrupted at. The real script runs here
// against a fake dockerd: `docker info` answers from a file the fake `systemctl reload docker`
// rewrites from daemon.json, which is how a reload makes dockerd pick the file up.

const script = resolve('deploy/host/verity-host-runtime');
const release = 'release-20260714.0';
const hostHasTools = ['jq', 'flock', 'sha512sum'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const describeHost = hostHasTools ? describe : describe.skip;

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const runscArgs = ['--platform=systrap', '--network=none'];
const projectArgs = ['--platform=systrap', '--network=sandbox', '--host-uds=create'];

function host(options: { daemon?: object; live?: object; reloadWorks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-host-runtime-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const daemonJson = join(root, 'etc-docker', 'daemon.json');
  mkdirSync(join(root, 'etc-docker'));
  if (options.daemon !== undefined) writeFileSync(daemonJson, JSON.stringify(options.daemon));
  const live = join(root, 'live.json');
  writeFileSync(live, JSON.stringify(options.live ?? { runc: { path: 'runc' } }));
  const calls = join(root, 'calls.log');
  // The runsc a real download would produce, and the checksum the pin file declares for it.
  const binary = `#!/bin/sh\necho 'runsc version ${release}'\n`;
  const sha = createHash('sha512').update(binary).digest('hex');
  writeFileSync(join(root, 'runsc.download'), binary);
  const pins = join(root, 'versions.env');
  writeFileSync(
    pins,
    [
      `RUNSC_RELEASE=${release}`,
      `RUNSC_SHA512_X86_64=${sha}`,
      `RUNSC_SHA512_AARCH64=${'b'.repeat(128)}`,
      `RUNSC_ARGS='${JSON.stringify(runscArgs)}'`,
      `RUNSC_PROJECT_ARGS='${JSON.stringify(projectArgs)}'`,
      '',
    ].join('\n'),
  );
  const tool = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >>'${calls}'\n${body}\n`,
      {
        mode: 0o755,
      },
    );
  tool('docker', `cat '${live}'`);
  tool('dockerd', `[ -e '${root}/validate-fails' ] && exit 1; jq -e . "$3" >/dev/null`);
  tool(
    'curl',
    `out=''; while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done; cp '${root}/runsc.download' "$out"`,
  );
  tool(
    'systemctl',
    `case "$1" in is-active) exit 0 ;; reload) ${
      options.reloadWorks === false
        ? 'exit 0'
        : `jq -c '.runtimes // {}' '${daemonJson}' > '${live}.tmp' && mv '${live}.tmp' '${live}'`
    } ;; esac`,
  );
  const systemd = join(root, 'run-systemd');
  mkdirSync(systemd);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    VERITY_HOST_RUNTIME_TEST: '1',
    VERITY_HOST_ARCH: 'x86_64',
    VERITY_DOCKER_DAEMON_JSON: daemonJson,
    VERITY_RUNSC_ROOT: join(root, 'runsc'),
    VERITY_HOST_RUNTIME_DIR: join(root, 'state'),
    VERITY_SYSTEMD_RUN_DIR: systemd,
    VERITY_HOST_RUNTIME_RELOAD_TIMEOUT: '2',
  };
  const run = (...args: string[]) => spawnSync(script, args, { env, encoding: 'utf8' });
  const callsOf = (name: string) =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${name} `))
      : [];
  const daemon = () => JSON.parse(readFileSync(daemonJson, 'utf8')) as Record<string, unknown>;
  const runtimePath = join(root, 'runsc', release, 'runsc');
  return {
    root,
    run,
    pins,
    daemonJson,
    daemon,
    callsOf,
    runtimePath,
    live,
    env,
    state: env.VERITY_HOST_RUNTIME_DIR,
  };
}

const secretOnly = (path: string) => ({ runsc: { path, runtimeArgs: runscArgs } });

describeHost('deploy/host/verity-host-runtime', () => {
  it('adds runsc-project to a runsc-only host and keeps every other Docker setting', () => {
    const h = host();
    const unrelated = {
      'log-level': 'info',
      'log-opts': { 'max-size': '10m' },
      runtimes: {
        ...secretOnly('/opt/verity/runsc/release-20260714.0/runsc'),
        nvidia: { path: '/usr/bin/nvidia-container-runtime' },
      },
    };
    writeFileSync(h.daemonJson, JSON.stringify(unrelated));

    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);

    expect(h.daemon()).toEqual({
      'log-level': 'info',
      'log-opts': { 'max-size': '10m' },
      runtimes: {
        nvidia: { path: '/usr/bin/nvidia-container-runtime' },
        runsc: { path: h.runtimePath, runtimeArgs: runscArgs },
        'runsc-project': { path: h.runtimePath, runtimeArgs: projectArgs },
      },
    });
    // A reload, never a restart: `systemctl reload docker` is what re-reads runtimes and
    // leaves running containers alone.
    expect(h.callsOf('systemctl')).toContain('systemctl reload docker');
    expect(h.callsOf('systemctl').some((line) => /restart/u.test(line))).toBe(false);
    expect(h.callsOf('dockerd')).toHaveLength(1);
  });

  it('does nothing on a host that already matches, however often it runs', () => {
    const h = host();
    expect(h.run('apply-pins', h.pins).status).toBe(0);
    const before = readFileSync(h.daemonJson);
    const counts = ['curl', 'dockerd', 'systemctl'].map((tool) => h.callsOf(tool).length);

    for (let i = 0; i < 2; i += 1) expect(h.run('apply-pins', h.pins).status).toBe(0);

    expect(readFileSync(h.daemonJson)).toEqual(before);
    expect(['curl', 'dockerd', 'systemctl'].map((tool) => h.callsOf(tool).length)).toEqual(counts);
  });

  it('only reloads when it was interrupted after writing daemon.json', () => {
    const h = host();
    expect(h.run('apply-pins', h.pins).status).toBe(0);
    // dockerd restarted from an older state, or the previous run died before its reload.
    writeFileSync(h.live, JSON.stringify(secretOnly(h.runtimePath)));
    const written = statSync(h.daemonJson).mtimeMs;
    const validations = h.callsOf('dockerd').length;

    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(h.daemonJson).mtimeMs).toBe(written);
    expect(h.callsOf('dockerd')).toHaveLength(validations);
    expect(JSON.parse(readFileSync(h.live, 'utf8'))).toHaveProperty('runsc-project');
  });

  it('restores the previous daemon.json when Docker does not take the new runtimes', () => {
    const h = host({ reloadWorks: false });
    const previous = JSON.stringify({ 'log-level': 'warn', runtimes: secretOnly('/old/runsc') });
    writeFileSync(h.daemonJson, previous);

    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the previous');
    expect(readFileSync(h.daemonJson, 'utf8')).toBe(previous);
  });

  it('leaves daemon.json untouched when dockerd rejects the merged configuration', () => {
    const h = host();
    writeFileSync(join(h.root, 'validate-fails'), '');
    const previous = JSON.stringify({ runtimes: secretOnly('/old/runsc') });
    writeFileSync(h.daemonJson, previous);

    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dockerd --validate');
    expect(readFileSync(h.daemonJson, 'utf8')).toBe(previous);
    expect(h.callsOf('systemctl').filter((line) => line.includes('reload'))).toEqual([]);
  });

  it('refuses a binary that does not match the pinned checksum and leaves nothing behind', () => {
    const h = host();
    writeFileSync(join(h.root, 'runsc.download'), '#!/bin/sh\necho tampered\n');
    const previous = JSON.stringify({ runtimes: secretOnly('/old/runsc') });
    writeFileSync(h.daemonJson, previous);

    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum');
    expect(readFileSync(h.daemonJson, 'utf8')).toBe(previous);
    expect(existsSync(join(h.root, 'runsc', release))).toBe(false);
  });

  it('reads the pin file as data and never executes it', () => {
    const h = host();
    const marker = join(h.root, 'executed');
    writeFileSync(h.pins, `${readFileSync(h.pins, 'utf8')}RUNSC_RELEASE=$(touch ${marker})\n`);
    h.run('apply-pins', h.pins);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['a flag outside the allowed set', { runsc: ['--network=host'] }],
    ['a runtime name it does not manage', { runc: ['--platform=systrap'] }],
    ['an empty argument list', { 'runsc-project': [] }],
  ])('rejects a request carrying %s before touching the host', (_label, override) => {
    const h = host();
    mkdirSync(h.state, { recursive: true });
    const runtimes = { runsc: runscArgs, 'runsc-project': projectArgs, ...override };
    writeFileSync(
      join(h.state, 'request.json'),
      JSON.stringify({
        version: 1,
        id: 'update-1',
        requirements: {
          release,
          sha512: { x86_64: 'a'.repeat(128), aarch64: 'b'.repeat(128) },
          runtimes,
        },
      }),
    );
    const result = h.run('apply-request');
    expect(result.status).toBe(1);
    expect(h.callsOf('curl')).toEqual([]);
    expect(existsSync(h.daemonJson)).toBe(false);
    const answer = JSON.parse(readFileSync(join(h.state, 'result.json'), 'utf8'));
    expect(answer).toMatchObject({ version: 1, id: 'update-1', ok: false });
    expect(answer.message).toContain('outside the allowed set');
  });

  it('answers the Updater once per request and not again for the same request', () => {
    const h = host();
    const binary = readFileSync(join(h.root, 'runsc.download'));
    mkdirSync(h.state, { recursive: true });
    const request = {
      version: 1,
      id: 'update-7',
      requirements: {
        release,
        sha512: {
          x86_64: createHash('sha512').update(binary).digest('hex'),
          aarch64: 'b'.repeat(128),
        },
        runtimes: { runsc: runscArgs, 'runsc-project': projectArgs },
      },
    };
    writeFileSync(join(h.state, 'request.json'), JSON.stringify(request));

    const first = h.run('apply-request');
    expect(first.status, first.stderr).toBe(0);
    const answer = JSON.parse(readFileSync(join(h.state, 'result.json'), 'utf8'));
    expect(answer).toMatchObject({ version: 1, id: 'update-7', ok: true });
    expect(h.daemon()).toHaveProperty(['runtimes', 'runsc-project']);

    // The path unit fires again whenever the Updater rewrites the same request on resume.
    const reloads = h.callsOf('systemctl').length;
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('systemctl')).toHaveLength(reloads);
    expect(readdirSync(h.state).filter((name) => name.startsWith('.result'))).toEqual([]);
  });
});
