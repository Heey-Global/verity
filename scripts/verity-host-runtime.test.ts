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
  symlinkSync,
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
        : `if [[ -f '${daemonJson}' ]]; then jq -c '.runtimes // {}' '${daemonJson}'; else echo '{"runc":{"path":"runc"}}'; fi > '${live}.tmp' && mv '${live}.tmp' '${live}'`
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
    VERITY_HOST_RUNTIME_PRIVATE_DIR: join(root, 'private'),
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
    // The Updater can write the request directory; the lock and the copy a restore reads from
    // must not be there for it to replace.
    expect(existsSync(join(h.state, 'daemon.json.previous'))).toBe(false);
    expect(existsSync(join(h.state, '.lock'))).toBe(false);
    expect(existsSync(join(h.root, 'private', 'daemon.json.previous'))).toBe(true);
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

// Newer gVisor releases ship `gvisor.tar.bz2`: runsc plus the sidecars in gvisor-bin/ it needs
// next to it. These run the real script against archives built here with the real tar.
const hostHasArchiveTools =
  hostHasTools &&
  ['tar', 'bzip2', 'cmp'].every(
    (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
  );
const describeArchive = hostHasArchiveTools ? describe : describe.skip;

const archiveRelease = 'release-20261026.0';
const sha512 = (data: string | Buffer) => createHash('sha512').update(data).digest('hex');

describeArchive('deploy/host/verity-host-runtime with a gVisor release archive', () => {
  function archiveHost(
    options: {
      runsc?: string;
      sidecars?: Record<string, string>;
      extra?: (dir: string) => void;
    } = {},
  ) {
    const h = host();
    const runsc = options.runsc ?? `#!/bin/sh\necho 'runsc version ${archiveRelease}'\n`;
    const content = join(h.root, 'archive-content');
    mkdirSync(join(content, 'gvisor-bin'), { recursive: true });
    writeFileSync(join(content, 'runsc'), runsc, { mode: 0o755 });
    writeFileSync(join(content, 'containerd-shim-runsc-v1'), 'shim', { mode: 0o755 });
    for (const [name, body] of Object.entries(
      options.sidecars ?? { gvisor_sentry: 'sentry', 'runsc-metric-server': 'metrics' },
    ))
      writeFileSync(join(content, 'gvisor-bin', name), body, { mode: 0o755 });
    options.extra?.(content);
    const archive = join(h.root, 'runsc.download');
    const members = readdirSync(content);
    const tar = spawnSync('tar', ['-cjf', archive, '-C', content, ...members], {
      encoding: 'utf8',
    });
    expect(tar.status, tar.stderr).toBe(0);
    const archiveSha = sha512(readFileSync(archive));
    const writePins = (pins: { runsc?: string; archive?: string } = {}) =>
      writeFileSync(
        h.pins,
        [
          `RUNSC_RELEASE=${archiveRelease}`,
          `RUNSC_SHA512_X86_64=${pins.runsc ?? sha512(runsc)}`,
          `RUNSC_SHA512_AARCH64=${'b'.repeat(128)}`,
          `RUNSC_ARCHIVE_SHA512_X86_64=${pins.archive ?? archiveSha}`,
          `RUNSC_ARCHIVE_SHA512_AARCH64=${'c'.repeat(128)}`,
          `RUNSC_ARGS='${JSON.stringify(runscArgs)}'`,
          `RUNSC_PROJECT_ARGS='${JSON.stringify(projectArgs)}'`,
          '',
        ].join('\n'),
      );
    writePins();
    const releaseDir = join(h.root, 'runsc', archiveRelease);
    return { ...h, archive, archiveSha, runscSha: sha512(runsc), writePins, releaseDir };
  }

  const previousDaemon = JSON.stringify({ runtimes: secretOnly('/opt/verity/runsc/old/runsc') });

  it('installs runsc with its sidecars and registers both runtimes on the release path', () => {
    const h = archiveHost();
    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);

    const runtimePath = join(h.releaseDir, 'runsc');
    expect(h.daemon()).toEqual({
      runtimes: {
        runsc: { path: runtimePath, runtimeArgs: runscArgs },
        'runsc-project': { path: runtimePath, runtimeArgs: projectArgs },
      },
    });
    expect(readdirSync(join(h.releaseDir, 'gvisor-bin')).sort()).toEqual([
      'gvisor_sentry',
      'runsc-metric-server',
    ]);
    // Docker never runs the shim; only what runsc needs is unpacked.
    expect(existsSync(join(h.releaseDir, 'containerd-shim-runsc-v1'))).toBe(false);
    expect(statSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(h.releaseDir, '.verity-archive-sha512'), 'utf8').trim()).toBe(
      h.archiveSha,
    );
    // No staging directory survives a successful install.
    expect(readdirSync(join(h.root, 'runsc'))).toEqual([archiveRelease]);
    expect(h.callsOf('curl')[0]).toContain(`/20261026.0/x86_64/gvisor.tar.bz2`);
  });

  it('does not download again once the release is installed and unchanged', () => {
    const h = archiveHost();
    expect(h.run('apply-pins', h.pins).status).toBe(0);
    const downloads = h.callsOf('curl').length;
    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);
    expect(h.callsOf('curl')).toHaveLength(downloads);
  });

  it.each([
    [
      'a corrupted archive',
      (h: ReturnType<typeof archiveHost>) => h.writePins({ archive: 'd'.repeat(128) }),
    ],
    [
      'a truncated download',
      (h: ReturnType<typeof archiveHost>) =>
        writeFileSync(h.archive, readFileSync(h.archive).subarray(0, 64)),
    ],
  ])('refuses %s and leaves the host as it was', (_label, damage) => {
    const h = archiveHost();
    writeFileSync(h.daemonJson, previousDaemon);
    damage(h);
    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the pinned');
    expect(readFileSync(h.daemonJson, 'utf8')).toBe(previousDaemon);
    expect(readdirSync(join(h.root, 'runsc'))).toEqual([]);
  });

  it('refuses an archive without the Sentry sidecar runsc needs', () => {
    const h = archiveHost({ sidecars: { 'runsc-metric-server': 'metrics' } });
    writeFileSync(h.daemonJson, previousDaemon);
    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lacks gvisor-bin/gvisor_sentry');
    expect(readFileSync(h.daemonJson, 'utf8')).toBe(previousDaemon);
    expect(readdirSync(join(h.root, 'runsc'))).toEqual([]);
  });

  it('refuses an archive whose runsc is not the pinned binary', () => {
    const h = archiveHost();
    h.writePins({ runsc: 'e'.repeat(128) });
    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runsc in the gVisor release-20261026.0 archive');
    expect(existsSync(h.releaseDir)).toBe(false);
  });

  it.each([
    [
      'a path outside the expected layout',
      (dir: string) => writeFileSync(join(dir, 'install.sh'), 'x'),
    ],
    [
      'a symbolic link',
      (dir: string) => symlinkSync('/etc/shadow', join(dir, 'gvisor-bin', 'gvisor-link')),
    ],
  ])('refuses an archive containing %s before unpacking it', (_label, extra) => {
    const h = archiveHost({ extra });
    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected layout');
    expect(readdirSync(join(h.root, 'runsc'))).toEqual([]);
  });

  it('replaces a release directory changed since it was verified, and keeps every other release', () => {
    const h = archiveHost();
    const older = join(h.root, 'runsc', 'release-20260714.0');
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, 'runsc'), 'previous release still used by running containers');
    expect(h.run('apply-pins', h.pins).status).toBe(0);
    writeFileSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry'), 'tampered');

    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry'), 'utf8')).toBe('sentry');
    expect(readFileSync(join(older, 'runsc'), 'utf8')).toBe(
      'previous release still used by running containers',
    );
    expect(readdirSync(join(h.root, 'runsc')).sort()).toEqual([
      'release-20260714.0',
      archiveRelease,
    ]);
  });

  it('rolls back to the previous single-binary release without a download', () => {
    const h = archiveHost();
    const legacy = `#!/bin/sh\necho 'runsc version ${release}'\n`;
    const legacyPath = join(h.root, 'runsc', release, 'runsc');
    mkdirSync(join(h.root, 'runsc', release), { recursive: true });
    writeFileSync(legacyPath, legacy, { mode: 0o755 });
    const legacyPins = join(h.root, 'legacy.env');
    writeFileSync(
      legacyPins,
      [
        `RUNSC_RELEASE=${release}`,
        `RUNSC_SHA512_X86_64=${sha512(legacy)}`,
        `RUNSC_SHA512_AARCH64=${'b'.repeat(128)}`,
        `RUNSC_ARGS='${JSON.stringify(runscArgs)}'`,
        `RUNSC_PROJECT_ARGS='${JSON.stringify(projectArgs)}'`,
        '',
      ].join('\n'),
    );
    expect(h.run('apply-pins', h.pins).status).toBe(0);
    const downloads = h.callsOf('curl').length;

    const result = h.run('apply-pins', legacyPins);
    expect(result.status, result.stderr).toBe(0);
    expect(h.callsOf('curl')).toHaveLength(downloads);
    expect(h.daemon()).toEqual({
      runtimes: {
        runsc: { path: legacyPath, runtimeArgs: runscArgs },
        'runsc-project': { path: legacyPath, runtimeArgs: projectArgs },
      },
    });
    // The newer release stays installed for the next attempt.
    expect(existsSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry'))).toBe(true);
  });

  it('finishes from a run interrupted halfway through unpacking', () => {
    const h = archiveHost();
    // What a killed run leaves: a staging directory, and a release directory without a record.
    mkdirSync(join(h.root, 'runsc', '.stage.abc123', 'tree', 'gvisor-bin'), { recursive: true });
    mkdirSync(join(h.releaseDir, 'gvisor-bin'), { recursive: true });
    writeFileSync(
      join(h.releaseDir, 'runsc'),
      readFileSync(join(h.root, 'archive-content', 'runsc')),
      {
        mode: 0o755,
      },
    );
    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry'))).toBe(true);
    expect(existsSync(join(h.releaseDir, '.verity-files.sha512'))).toBe(true);
    // Each killed run would otherwise leave a full archive behind for good.
    expect(readdirSync(join(h.root, 'runsc')).filter((name) => name.startsWith('.stage.'))).toEqual(
      [],
    );
  });

  it('answers an Updater request that pins an archive', () => {
    const h = archiveHost();
    mkdirSync(h.state, { recursive: true });
    writeFileSync(
      join(h.state, 'request.json'),
      JSON.stringify({
        version: 1,
        id: 'update-archive',
        requirements: {
          release: archiveRelease,
          sha512: { x86_64: h.runscSha, aarch64: 'b'.repeat(128) },
          archiveSha512: { x86_64: h.archiveSha, aarch64: 'c'.repeat(128) },
          runtimes: { runsc: runscArgs, 'runsc-project': projectArgs },
        },
      }),
    );
    const result = h.run('apply-request');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(h.state, 'result.json'), 'utf8'))).toMatchObject({
      id: 'update-archive',
      ok: true,
    });
    expect(existsSync(join(h.releaseDir, 'gvisor-bin', 'gvisor_sentry'))).toBe(true);
  });

  it('rejects a request whose archive pin is malformed before downloading', () => {
    const h = archiveHost();
    mkdirSync(h.state, { recursive: true });
    writeFileSync(
      join(h.state, 'request.json'),
      JSON.stringify({
        version: 1,
        id: 'update-bad',
        requirements: {
          release: archiveRelease,
          sha512: { x86_64: h.runscSha, aarch64: 'b'.repeat(128) },
          archiveSha512: { x86_64: 'not-a-sum', aarch64: 'c'.repeat(128) },
          runtimes: { runsc: runscArgs, 'runsc-project': projectArgs },
        },
      }),
    );
    expect(h.run('apply-request').status).toBe(1);
    expect(h.callsOf('curl')).toEqual([]);
  });
});

describeHost('verity-host-runtime install-self', () => {
  function installed(options: { agent?: object | null; copy?: string | null } = {}) {
    const h = host();
    const libexec = join(h.root, 'libexec');
    mkdirSync(libexec);
    mkdirSync(h.state, { recursive: true });
    const target = join(libexec, 'verity-host-runtime');
    if (options.copy !== null)
      writeFileSync(target, options.copy ?? '#!/bin/sh\necho old\n', { mode: 0o755 });
    const agent = join(h.state, 'agent.json');
    if (options.agent !== null)
      writeFileSync(
        agent,
        JSON.stringify(
          options.agent ?? { version: 1, trigger: 'systemd-path', builder: 'systemd-path' },
        ),
      );
    const run = () =>
      spawnSync(script, ['install-self'], {
        env: { ...h.env, VERITY_HOST_RUNTIME_LIBEXEC: libexec },
        encoding: 'utf8',
      });
    return { ...h, target, agent, run };
  }

  it('replaces the installed copy and only then advertises archive pins', () => {
    const h = installed();
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(h.target, 'utf8')).toBe(readFileSync(script, 'utf8'));
    expect(statSync(h.target).mode & 0o777).toBe(0o755);
    // Every key the installer wrote stays; the Updater reads trigger and builder from it.
    expect(JSON.parse(readFileSync(h.agent, 'utf8'))).toEqual({
      version: 1,
      trigger: 'systemd-path',
      builder: 'systemd-path',
      runtimeArtifacts: ['binary', 'archive'],
    });
    expect(readdirSync(join(h.root, 'libexec'))).toEqual(['verity-host-runtime']);
  });

  it('leaves a host the installer never set up alone', () => {
    const h = installed({ copy: null, agent: null });
    const result = h.run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(h.target)).toBe(false);
    expect(existsSync(h.agent)).toBe(false);
  });

  it('does not create an agent record the installer did not write', () => {
    const h = installed({ agent: null });
    expect(h.run().status).toBe(0);
    expect(readFileSync(h.target, 'utf8')).toBe(readFileSync(script, 'utf8'));
    expect(existsSync(h.agent)).toBe(false);
  });
});

describeHost('durable Docker runtime configuration recovery', () => {
  it('recovers a killed configuration publication before reconciling forward', () => {
    const h = host();
    const systemctl = join(h.root, 'bin/systemctl');
    const original = readFileSync(systemctl, 'utf8');
    writeFileSync(
      systemctl,
      '#!/bin/bash\nif [[ $1 == reload ]]; then kill -KILL "$PPID"; exit 1; fi\nexit 0\n',
      { mode: 0o755 },
    );
    expect(h.run('apply-pins', h.pins).signal).toBe('SIGKILL');
    expect(existsSync(join(h.root, 'private/daemon-install/pending'))).toBe(true);
    writeFileSync(systemctl, original, { mode: 0o755 });
    const result = h.run('apply-pins', h.pins);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(h.root, 'private/daemon-install'))).toBe(false);
    expect(h.daemon()).toMatchObject({ runtimes: { runsc: { path: h.runtimePath } } });
  });
  it('keeps its checkpoint when restoration cannot be verified', () => {
    const h = host();
    writeFileSync(join(h.root, 'bin/systemctl'), '#!/bin/bash\n[[ $1 == is-active ]]\n', {
      mode: 0o755,
    });
    const result = h.run('apply-pins', h.pins);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('recovery-required');
    expect(result.stderr).not.toContain('was restored');
    expect(existsSync(join(h.root, 'private/daemon-install/pending'))).toBe(true);
  });
});
