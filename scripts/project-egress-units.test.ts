import { readFileSync } from 'node:fs';
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
  expect(preflight).toContain('flock --exclusive --nonblock');
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
