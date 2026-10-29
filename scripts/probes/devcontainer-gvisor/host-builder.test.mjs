import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = (name) =>
  readFileSync(new URL(`../../../deploy/buildkit/${name}`, import.meta.url), 'utf8');
test('production worker preserves snapshots and delegates only to gVisor', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-builder-'));
  try {
    const runtime = join(root, 'runsc-real');
    writeFileSync(
      runtime,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(runtime, 0o755);
    for (const helper of ['runsc-buildkit-args.sh', 'runsc-netns.sh']) {
      writeFileSync(join(root, helper), source(helper));
      chmodSync(join(root, helper), 0o755);
    }
    const wrapper = join(root, 'runsc');
    writeFileSync(wrapper, source('runsc').replaceAll('/usr/local/libexec/verity-buildkit', root));
    const result = spawnSync('sh', [wrapper, 'run', '--bundle', '/bundle path', '--keep', 'id'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      '--root=/run/verity-buildkit/runsc',
      '--platform=systrap',
      '--network=sandbox',
      '--overlay2=none',
      'run',
      '--bundle',
      '/bundle path',
      'id',
    ]);
    rmSync(runtime);
    assert.equal(spawnSync('sh', [wrapper, 'run', 'id']).status, 127);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('host configuration restricts worker authority and bounds service resources', () => {
  const config = source('buildkitd.toml');
  assert.match(config, /^insecure-entitlements = \[\]$/m);
  assert.match(config, /^ {2}address = \["unix:\/\/\/run\/verity-buildkit\/buildkitd.sock"\]$/m);
  assert.match(
    config,
    /\[worker\.oci\][\s\S]*binary = "\/usr\/local\/libexec\/verity-buildkit\/runsc"/,
  );
  assert.match(config, /max-parallelism = 1/);
  assert.match(config, /noProcessSandbox = false/);
  assert.match(config, /\[worker\.containerd\]\s+enabled = false/);
  assert.match(config, /snapshotter = "auto"/);
  const unit = source('verity-buildkit.service');
  for (const constraint of [
    'MemoryMax=@MEMORY_MAX@',
    'MemorySwapMax=0',
    'CPUQuota=@CPU_QUOTA@',
    'TasksMax=512',
    'ProtectSystem=strict',
    'RuntimeDirectoryPreserve=yes',
    'NoNewPrivileges=yes',
  ])
    assert(unit.includes(constraint), constraint);
  assert.match(unit, /^InaccessiblePaths=.*\/run\/docker.sock.*\/var\/run\/docker.sock/m);
});

test('installer fills every placeholder in the unit from the host resource limits', () => {
  // A placeholder the installer does not replace reaches systemd as an invalid
  // value; systemd drops the setting with a warning and the unit runs unbounded.
  const placeholders = [...source('verity-buildkit.service').matchAll(/@([A-Z_]+)@/g)].map(
    (match) => match[1],
  );
  const installer = source('install.sh');
  assert.deepEqual(placeholders.sort(), ['CPU_QUOTA', 'MEMORY_MAX']);
  for (const name of placeholders) assert(installer.includes(`s/@${name}@/`), name);
});

test('resource limits scale with the host within their bounds', () => {
  const limits = (cpus, memGiB) => {
    const result = spawnSync(
      'bash',
      [new URL('../../../deploy/buildkit/resources.sh', import.meta.url).pathname],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          VERITY_BUILDKIT_HOST_CPUS: String(cpus),
          VERITY_BUILDKIT_HOST_MEM_KIB: String(memGiB * 1024 * 1024),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.equal(limits(1, 2), 'CPU_QUOTA=100%\nMEMORY_MAX=2048M\n');
  assert.equal(limits(4, 16), 'CPU_QUOTA=200%\nMEMORY_MAX=4096M\n');
  assert.equal(limits(16, 64), 'CPU_QUOTA=800%\nMEMORY_MAX=8192M\n');
  assert.notEqual(
    spawnSync(
      'bash',
      [new URL('../../../deploy/buildkit/resources.sh', import.meta.url).pathname],
      {
        env: { ...process.env, VERITY_BUILDKIT_HOST_CPUS: '0' },
      },
    ).status,
    0,
  );
});

test('service waits for BuildKit readiness and keeps its trace socket in a writable runtime directory', () => {
  const unit = source('verity-buildkit.service');
  assert.match(unit, /^ExecStartPre=\+.*snapshotter-migrate.sh recover$/m);
  assert.match(unit, /^ExecStartPost=\+.*snapshotter-migrate.sh recover-verify$/m);
  assert.match(unit, /^Type=notify$/m);
  assert.match(unit, /^NotifyAccess=main$/m);
  assert.match(unit, /^TimeoutStartSec=60$/m);
  const exec = /^ExecStart=(.+)$/m.exec(unit)?.[1];
  assert(exec, 'Missing service command');
  const traceSocket = /--otel-socket-path=(\S+)/.exec(exec)?.[1];
  assert(traceSocket, 'BuildKit defaults its trace socket outside the service writable paths');
  const writable = /^ReadWritePaths=(.+)$/m.exec(unit)?.[1].split(/\s+/) ?? [];
  assert(
    writable.some((directory) => traceSocket.startsWith(`${directory}/`)),
    'Trace socket must remain within the narrow writable paths',
  );
});

test('runsc keeps runtime state within the service writable paths', () => {
  const root = /--root=(\S+)/.exec(source('runsc'))?.[1];
  assert(root, 'runsc defaults its state outside the writable runtime directory');
  const writable =
    /^ReadWritePaths=(.+)$/m.exec(source('verity-buildkit.service'))?.[1].split(/\s+/) ?? [];
  assert(writable.some((directory) => root.startsWith(`${directory}/`)));
});
