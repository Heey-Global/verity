import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/host/verity-host-builder is the root process that changes the devcontainer builder
// when the managed Updater asks. What must hold: it acts only on an official image digest
// whose release signature it verified itself, installs the bundle from that image and nothing
// the request carries, leaves an unchanged builder alone, and puts the previous builder back
// when the new one fails to install or to start. The real script runs here against fake
// docker, cosign and systemctl; the release image is a directory `docker cp` streams from.

const script = resolve('deploy/host/verity-host-builder');
const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const hostHasTools = ['jq', 'flock', 'sha256sum', 'tar'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);
const describeHost = hostHasTools ? describe : describe.skip;

let roots: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  servers = [];
});

interface HostOptions {
  readonly receipt?: boolean;
  readonly signed?: boolean;
  readonly label?: string;
  readonly installFails?: boolean;
  readonly startsAfterInstall?: boolean;
  /** Extra shell run by the bundle's installer after it rewrote the builder. */
  readonly duringInstall?: string;
  /** What the local store says the pulled image resolves to. */
  readonly localDigest?: string;
}

async function host(options: HostOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-host-builder-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const state = join(root, 'state');
  const payload = join(root, 'image', 'opt', 'verity-install', 'deploy');
  const config = join(root, 'etc-verity-buildkit');
  const libexec = join(root, 'libexec-verity-buildkit');
  const unit = join(root, 'verity-buildkit.service');
  const runDir = join(root, 'run-verity-buildkit');
  for (const dir of [bin, state, config, libexec, runDir]) mkdirSync(dir, { recursive: true });
  const calls = join(root, 'calls.log');
  const active = join(root, 'active');

  // The builder as it is before the update.
  writeFileSync(join(config, 'buildkitd.toml'), 'previous\n');
  writeFileSync(join(libexec, 'buildkitd'), 'previous\n');
  writeFileSync(unit, 'previous\n');
  writeFileSync(active, '');
  if (options.receipt !== false)
    writeFileSync(join(state, 'devcontainer-builder.json'), '{"version":1,"gid":1234}\n');
  const socket = join(runDir, 'buildkitd.sock');
  const server = createServer();
  await new Promise<void>((done) => server.listen(socket, done));
  servers.push(server);

  // The bundle inside the release image. Its installer stands in for deploy/buildkit/install.sh.
  mkdirSync(join(payload, 'buildkit'), { recursive: true });
  mkdirSync(join(payload, 'gvisor'));
  mkdirSync(join(payload, 'host'));
  writeFileSync(
    join(payload, 'buildkit', 'install.sh'),
    `printf 'install.sh gid=%s\\n' "$VERITY_BUILDKIT_GID" >>'${calls}'\n` +
      `printf 'new\\n' >'${config}/buildkitd.toml'\nprintf 'new\\n' >'${unit}'\n` +
      (options.duringInstall ?? '') +
      (options.installFails === true ? 'exit 1\n' : '') +
      (options.startsAfterInstall === false ? `rm -f '${active}'\n` : ''),
  );
  writeFileSync(join(payload, 'buildkit', 'buildkitd.toml'), 'release\n');
  writeFileSync(join(payload, 'gvisor', 'versions.env'), 'RUNSC_RELEASE=release-20260714.0\n');
  writeFileSync(join(payload, 'host', 'verity-host-runtime'), '#!/bin/sh\n');
  writeFileSync(join(payload, 'host', 'verity-host-diagnostics'), '#!/bin/sh\n');

  const tool = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/usr/bin/env bash\nprintf '${name} %s\\n' "$*" >>'${calls}'\n${body}\n`,
      { mode: 0o755 },
    );
  tool(
    'docker',
    `case "$1 $2" in
  'image inspect') case "$4" in *RepoDigests*) printf '%s\\n' ${options.localDigest === undefined ? '"$5"' : `'${options.localDigest}'`} ;; *Labels*) printf '%s\\n' '${options.label ?? '1'}' ;; esac ;;
  'create '*) echo container-1 ;;
  'cp '*) path=\${2#container-1:/opt/verity-install/deploy/}; tar -C "${payload}/$(dirname "$path")" -c "$(basename "$path")" ;;
esac`,
  );
  tool('cosign', options.signed === false ? 'exit 1' : 'exit 0');
  tool(
    'systemctl',
    `case "$1" in is-active) [ -e '${active}' ] ;; restart) touch '${active}' ;; esac`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    VERITY_HOST_RUNTIME_TEST: '1',
    VERITY_HOST_BUILDER_COSIGN: join(bin, 'cosign'),
    VERITY_HOST_RUNTIME_DIR: state,
    VERITY_HOST_BUILDER_DIR: join(root, 'host-builder'),
    VERITY_BUILDKIT_RUN_DIR: runDir,
    VERITY_BUILDKIT_READY_TIMEOUT: '1',
    VERITY_BUILDKIT_CONFIG_DIR: config,
    VERITY_BUILDKIT_LIBEXEC: libexec,
    VERITY_BUILDKIT_UNIT_FILE: unit,
  };
  const run = (...args: string[]) => spawnSync(script, args, { env, encoding: 'utf8' });
  const start = (...args: string[]) => spawn(script, args, { env, stdio: 'ignore' });
  const request = (id: string, requested = image) =>
    writeFileSync(
      join(state, 'builder-request.json'),
      JSON.stringify({ version: 1, id, image: requested }),
    );
  const result = () =>
    JSON.parse(readFileSync(join(state, 'builder-result.json'), 'utf8')) as {
      id: string;
      ok: boolean;
      message: string;
    };
  const callsOf = (name: string) =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith(`${name} `))
      : [];
  const record = join(root, 'host-builder', 'bundle.json');
  return { root, run, start, request, result, callsOf, config, unit, payload, record, state };
}

describeHost('deploy/host/verity-host-builder', () => {
  it('installs the bundle of a verified release image with the installer-recorded group', async () => {
    const h = await host();
    h.request('update-1');
    const run = h.run('apply-request');
    expect(run.status, run.stderr).toBe(0);
    expect(h.result()).toMatchObject({ id: 'update-1', ok: true });
    expect(h.callsOf('install.sh')).toEqual(['install.sh gid=1234']);
    expect(h.callsOf('cosign')[0]).toContain(image);
    expect(readFileSync(join(h.config, 'buildkitd.toml'), 'utf8')).toBe('new\n');
    expect(JSON.parse(readFileSync(h.record, 'utf8'))).toMatchObject({ version: 1 });
  });

  // Every update asks; only a bundle that changed may interrupt the builds in progress.
  it('leaves a builder that already matches the release alone', async () => {
    const h = await host();
    h.request('update-1');
    expect(h.run('apply-request').status).toBe(0);
    h.request('update-2');
    expect(h.run('apply-request').status).toBe(0);
    expect(h.result()).toMatchObject({ id: 'update-2', ok: true });
    expect(h.callsOf('install.sh')).toHaveLength(1);
  });

  // The installer records what it installed, so the first update after it changes nothing.
  it('agrees with the record the installer writes for the same bundle', async () => {
    const h = await host();
    const recorded = h.run('record', h.payload);
    expect(recorded.status, recorded.stderr).toBe(0);
    h.request('update-1');
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('install.sh')).toHaveLength(0);
  });

  it('reinstalls when a file the builder installer reads changed, not for other files', async () => {
    const h = await host();
    expect(h.run('record', h.payload).status).toBe(0);
    writeFileSync(join(h.payload, 'host', 'verity-host-diagnostics'), '#!/bin/sh\n# changed\n');
    h.request('update-1');
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('install.sh')).toHaveLength(0);
    writeFileSync(join(h.payload, 'gvisor', 'versions.env'), 'RUNSC_RELEASE=release-20260801.0\n');
    h.request('update-2');
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('install.sh')).toHaveLength(1);
  });

  // The requester is not trusted: an unsigned image, another repository, or an image that
  // does not declare the bundle contract changes nothing.
  it.each([
    ['an image without a valid release signature', { signed: false }, image],
    ['an image that does not declare the builder contract', { label: '<no value>' }, image],
    ['a tag instead of a digest', {}, 'ghcr.io/heey-global/verity/verity-server:latest'],
    ['another repository', {}, `ghcr.io/example/verity-server@sha256:${'a'.repeat(64)}`],
  ] satisfies [string, HostOptions, string][])('refuses %s', async (_, options, requested) => {
    const h = await host(options);
    h.request('update-1', requested);
    expect(h.run('apply-request').status).not.toBe(0);
    expect(h.result()).toMatchObject({ id: 'update-1', ok: false });
    expect(h.callsOf('install.sh')).toHaveLength(0);
    expect(readFileSync(join(h.config, 'buildkitd.toml'), 'utf8')).toBe('previous\n');
  });

  it('refuses a bundle that contains a symbolic link', async () => {
    const h = await host();
    symlinkSync('/etc/shadow', join(h.payload, 'buildkit', 'stolen'));
    h.request('update-1');
    expect(h.run('apply-request').status).not.toBe(0);
    expect(h.result().message).toContain('symbolic link');
    expect(h.callsOf('install.sh')).toHaveLength(0);
  });

  it('asks for the installer on a host whose builder the installer never verified', async () => {
    const h = await host({ receipt: false });
    h.request('update-1');
    expect(h.run('apply-request').status).not.toBe(0);
    expect(h.result().message).toContain('re-run the Verity installer');
  });

  it.each([
    ['fails to install', { installFails: true }, 'installation failed'],
    ['does not become ready', { startsAfterInstall: false }, 'did not become ready'],
  ] satisfies [string, HostOptions, string][])(
    'restores the previous builder when the new one %s',
    async (_, options, message) => {
      const h = await host(options);
      h.request('update-1');
      expect(h.run('apply-request').status).not.toBe(0);
      expect(h.result()).toMatchObject({ ok: false });
      expect(h.result().message).toContain(message);
      expect(readFileSync(join(h.config, 'buildkitd.toml'), 'utf8')).toBe('previous\n');
      expect(readFileSync(h.unit, 'utf8')).toBe('previous\n');
      expect(h.callsOf('systemctl')).toContain('systemctl restart verity-buildkit.service');
      expect(existsSync(h.record)).toBe(false);
    },
  );

  // systemd stops the unit with TERM at its timeout and at shutdown; a half-installed builder
  // would otherwise stay until some later update happened to ask again.
  // systemd stops the unit at its timeout and at shutdown. With KillMode=mixed only the request
  // process gets TERM; the previous builder must come back and the answer must still be
  // published, or the Updater sees silence and the host keeps a half-installed builder.
  it('restores the previous builder and answers when the service is stopped mid-installation', async () => {
    const h = await host({ duringInstall: `touch '${'MARKER'}'\nsleep 30\n` });
    const marker = join(h.root, 'installing');
    writeFileSync(
      join(h.payload, 'buildkit', 'install.sh'),
      readFileSync(join(h.payload, 'buildkit', 'install.sh'), 'utf8').replace('MARKER', marker),
    );
    h.request('update-1');
    const service = h.start('apply-request');
    const exited = new Promise<number | null>((done) => service.on('exit', (code) => done(code)));
    const started = Date.now();
    while (!existsSync(marker)) {
      if (Date.now() - started > 10_000) throw new Error('the installer never started');
      await new Promise((done) => setTimeout(done, 50));
    }
    service.kill('SIGTERM');
    expect(await exited).not.toBe(0);
    // Well before the installer's own 30 seconds: the stop ended its whole process group.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(h.result()).toMatchObject({ id: 'update-1', ok: false });
    expect(h.result().message).toContain('interrupted');
    expect(readFileSync(join(h.config, 'buildkitd.toml'), 'utf8')).toBe('previous\n');
    expect(h.callsOf('systemctl')).toContain('systemctl restart verity-buildkit.service');
    expect(existsSync(h.record)).toBe(false);
  });

  // The request directory is mounted into the Updater. Anything this root process later
  // executes or restores from there, the requester could replace after verification.
  it('keeps staging, verifier, lock and backup out of the shared request directory', async () => {
    const h = await host({ installFails: true });
    h.request('update-1');
    h.run('apply-request');
    expect(readdirSync(h.state).sort()).toEqual([
      'builder-request.json',
      'builder-result.json',
      'devcontainer-builder.json',
    ]);
  });

  it('refuses an image the local store does not resolve to the requested digest', async () => {
    const h = await host({
      localDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
    });
    h.request('update-1');
    expect(h.run('apply-request').status).not.toBe(0);
    expect(h.callsOf('cosign')).toHaveLength(0);
    expect(h.callsOf('install.sh')).toHaveLength(0);
  });

  // A path unit does not start a running service again, so a request written meanwhile would
  // otherwise wait for the Updater's whole timeout.
  it('also answers a request written while it was answering the previous one', async () => {
    const h = await host();
    h.request('update-1');
    const newer = JSON.stringify({ version: 1, id: 'update-2', image });
    writeFileSync(
      join(h.payload, 'buildkit', 'install.sh'),
      readFileSync(join(h.payload, 'buildkit', 'install.sh'), 'utf8') +
        `printf '%s' '${newer}' >'${join(h.state, 'builder-request.json')}'\n`,
    );
    expect(h.run('apply-request').status).toBe(0);
    expect(h.result()).toMatchObject({ id: 'update-2', ok: true });
  });

  it('does not restart the builder for a documentation change', async () => {
    const h = await host();
    expect(h.run('record', h.payload).status).toBe(0);
    writeFileSync(join(h.payload, 'buildkit', 'README.md'), '# changed\n');
    h.request('update-1');
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('install.sh')).toHaveLength(0);
  });

  it('answers a request it already answered successfully without doing anything', async () => {
    const h = await host();
    h.request('update-1');
    expect(h.run('apply-request').status).toBe(0);
    const docker = h.callsOf('docker').length;
    expect(h.run('apply-request').status).toBe(0);
    expect(h.callsOf('docker')).toHaveLength(docker);
  });
});
