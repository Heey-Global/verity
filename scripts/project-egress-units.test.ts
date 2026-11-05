import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { projectSocketBindingName } from '../packages/server/src/project-relay-identity.js';
import { expect, it } from 'vitest';
import { verifyProjectEgressDockerHost } from '../packages/server/src/project-egress-host-service.js';

function unit(file: string) {
  return readFileSync(new URL(`../deploy/egress/${file}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'));
}

it('accepts only the Docker release pinned by the runtime fixture', () => {
  const dockerfile = readFileSync(
    new URL('../deploy/gvisor-ci.Dockerfile', import.meta.url),
    'utf8',
  );
  const version = /^FROM docker:([0-9.]+)-dind@sha256:/mu.exec(dockerfile)?.[1];
  expect(version).toBeDefined();
  verifyProjectEgressDockerHost({
    OSType: 'linux',
    ServerVersion: version,
    LiveRestoreEnabled: false,
    SecurityOptions: ['name=seccomp'],
  });
});

it('requires an every-start fence even when the bootstrap oneshot is already active', () => {
  const docker = unit('docker-egress.conf');
  const host = unit('verity-egress-host.service');
  const preflight = docker.find((line) => line.startsWith('ExecStartPre='));
  expect(preflight).toContain('flock --exclusive --timeout 15');
  const stopTimeout = Number(
    host.find((line) => line.startsWith('TimeoutStopSec='))?.split('=')[1],
  );
  expect(stopTimeout).toBeLessThan(15);
  expect(preflight).toContain('project-egress-host-main.mjs restore');
  expect(docker).toContain('Upholds=verity-egress-host.service');
  expect(host).toContain('After=verity-egress-bootstrap.service docker.service');
  expect(host).toContain('BindsTo=docker.service');
  expect(host).toContain('PartOf=docker.service');
  // A reciprocal ordering dependency would make neither service ready.
  expect(docker.some((line) => /^After=.*verity-egress-host/u.test(line))).toBe(false);
});

it('uses actual validated readiness and independent post-crash denial', () => {
  const host = unit('verity-egress-host.service');
  expect(host).toContain('Type=notify');
  expect(host).toContain('NotifyAccess=all');
  expect(host).toContain('KillMode=control-group');
  expect(host.find((line) => line.startsWith('ExecStart='))).toContain('--no-fork');
  expect(host.find((line) => line.startsWith('ExecStopPost='))).toContain(
    'project-egress-host-main.mjs deny',
  );
});

it('waits for native Docker readiness before loading fixture images', () => {
  const installer = readFileSync(
    new URL('./probes/project-egress/boot-native-install.sh', import.meta.url),
    'utf8',
  );
  const dockerUnit = installer.match(
    /Description=Pinned disposable Docker daemon[\s\S]*?\nUNIT/u,
  )?.[0];
  expect(dockerUnit).toBeDefined();
  expect(dockerUnit).toMatch(/^Type=notify$/mu);
});

it('runs the native Server as the same identity as its actual Runner probes', () => {
  const installer = readFileSync(
    new URL('./probes/project-egress/boot-native-install.sh', import.meta.url),
    'utf8',
  );
  const guest = readFileSync(
    new URL('./probes/project-egress/boot-guest.py', import.meta.url),
    'utf8',
  );
  const serverUnit = installer.match(/Description=Disposable real Verity[\s\S]*?\nUNIT/u)?.[0];
  expect(serverUnit).toBeDefined();
  const uid = /^User=(\d+)$/mu.exec(serverUnit!)?.[1];
  const gid = /^Group=(\d+)$/mu.exec(serverUnit!)?.[1];
  expect(uid).toBeDefined();
  expect(gid).toBeDefined();
  expect(uid).not.toBe('0');
  expect(guest).toContain(`'--user', '${uid}:${gid}'`);
  expect(guest).toContain(`'socketOwnerUid': ${uid},`);
});

it('keeps native generation-bound broker sockets within Linux path limits', () => {
  const installer = readFileSync(
    new URL('./probes/project-egress/boot-native-install.sh', import.meta.url),
    'utf8',
  );
  const guest = readFileSync(
    new URL('./probes/project-egress/boot-guest.py', import.meta.url),
    'utf8',
  );
  const dataRoot = /c\['data-root'\] = '([^']+)'/u.exec(installer)?.[1] ?? '/var/lib/docker';
  const volume = /'dataVolume': '([^']+)'/u.exec(guest)?.[1];
  const subpath = /'brokerSubpath': '([^']+)'/u.exec(guest)?.[1];
  expect(volume).toBeDefined();
  expect(subpath).toBeDefined();
  const socket = join(
    dataRoot,
    'volumes',
    volume!,
    '_data',
    subpath!,
    projectSocketBindingName({ projectId: 'project', containerGeneration: 'generation' }),
    'broker.sock',
  );
  expect(Buffer.byteLength(socket)).toBeLessThan(108);
});

it('keeps deadline evidence outside the runtime control socket directory and bounds writable pins', () => {
  const helper = readFileSync(
    new URL('../deploy/egress/project-egress-deadline.py', import.meta.url),
    'utf8',
  );
  const state = /^STATE = Path\('([^']+)'\)/mu.exec(helper)?.[1];
  const pins = /^PINS = Path\('([^']+)'\)/mu.exec(helper)?.[1];
  const host = unit('verity-egress-host.service');
  const writable = host.find((line) => line.startsWith('ReadWritePaths='));
  expect(state).toBeDefined();
  expect(state).toMatch(/^\/var\/lib\/verity-egress\//u);
  expect(host).toContain('RuntimeDirectory=verity-egress');
  // Docker bind-mounts the directory inode; restarts must preserve that mount.
  expect(host).toContain('RuntimeDirectoryPreserve=yes');
  expect(writable).toContain(`-${pins}`);
  expect(writable).not.toMatch(/(?:=|\s)\/?sys\/fs\/bpf(?:\s|$)/u);
});

it('cleans a stale socket without replacing its directory or stealing an active controller lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'egress-unit-'));
  const directory = join(root, 'runtime');
  const lock = join(root, 'service.lock');
  const socket = join(directory, 'control.sock');
  await mkdir(directory);
  await writeFile(socket, 'stale socket');
  const before = await stat(directory);
  const cleanup = unit('verity-egress-host.service').find((line) =>
    line.startsWith('ExecStartPre='),
  )!;
  const [command, ...args] = cleanup
    .slice('ExecStartPre='.length)
    .split(/\s+/u)
    .map((arg) =>
      arg
        .replace('/var/lib/verity-egress/service.lock', lock)
        .replace('/run/verity-egress/control.sock', socket),
    );
  const owner = spawn('/usr/bin/flock', [
    '--exclusive',
    '--no-fork',
    lock,
    process.execPath,
    '-e',
    "process.stdout.write('locked'); setInterval(() => {}, 1000)",
  ]);
  try {
    await once(owner.stdout, 'data');
    await expect(promisify(execFile)(command!, args)).rejects.toThrow();
    expect(await readFile(socket, 'utf8')).toBe('stale socket');
    const exited = once(owner, 'exit');
    owner.kill();
    await exited;
    await promisify(execFile)(command!, args);
    await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(directory)).ino).toBe(before.ino);
  } finally {
    owner.kill();
    await rm(root, { recursive: true, force: true });
  }
});

it('targets the production helper mode in the native helper-death proof', () => {
  const channel = readFileSync('packages/server/src/project-egress-deadline-channel.ts', 'utf8');
  // Derive the command from the actual launcher so a transport change cannot silently
  // leave the native containment probe looking for a process that never exists.
  const launchMode = /project-egress-deadline\.py', '(--[a-z]+)'/u.exec(channel)?.[1];
  expect(launchMode).toBeDefined();
  for (const file of ['host-smoke.ts', 'composed-proof.py', 'test_composed.py']) {
    const source = readFileSync(`scripts/probes/project-egress/${file}`, 'utf8');
    expect(source).toContain(`project-egress-deadline.py\\0${launchMode}`);
  }
});
