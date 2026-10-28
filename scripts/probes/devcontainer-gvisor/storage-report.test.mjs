import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const directory = new URL('../../../deploy/buildkit/', import.meta.url).pathname;
test('storage service preserves custom diagnostic paths and escapes systemd specifiers', () => {
  const render = (path) =>
    spawnSync(
      'bash',
      [
        join(directory, 'storage-service.sh'),
        join(directory, 'verity-build-storage.service'),
        path,
      ],
      { encoding: 'utf8' },
    );
  const result = render('/var/lib/evidence "custom"%');
  assert.equal(result.status, 0, result.stderr);
  assert(
    result.stdout.includes(
      'Environment="VERITY_HOST_DIAGNOSTIC_DIR=/var/lib/evidence \\"custom\\"%%"',
    ),
  );
  assert(result.stdout.includes('ReadWritePaths="/var/lib/evidence \\"custom\\"%%"'));
  assert.doesNotMatch(result.stdout, /@[A-Z_]+@/);
  for (const path of ['relative', '/', '/data/../other', '/data//other', '/data\nother']) {
    const invalid = render(path);
    assert.notEqual(invalid.status, 0, path);
    assert.equal(invalid.stdout, '');
  }
});

test('read-only report attributes real filesystems and preserves unavailable evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-report-'));
  try {
    const client = join(root, 'buildctl');
    writeFileSync(
      client,
      '#!/bin/sh\nprintf \'[{"Labels":{"org.mobyproject.buildkit.worker.snapshotter":"native"}}]\\n\'\n',
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [join(directory, 'storage-report.sh'), root, root, root, root, join(root, 'missing')],
      {
        env: { ...process.env, VERITY_BUILDCTL: client, VERITY_STORAGE_REPORT_USAGE: '0' },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.match(report.hostBootId, /^[a-f0-9-]{36}$/);
    if (existsSync('/etc/machine-id')) assert.match(report.hostIdentity, /^[a-f0-9]{64}$/);
    else assert.equal(report.hostIdentity, undefined);
    assert(report.roots.slice(0, 3).every((entry) => entry.state === 'available'));
    assert(Number.isFinite(Date.parse(report.roots[0].observedAt)));
    assert.equal(new Set(report.roots.slice(0, 3).map((entry) => entry.filesystemId)).size, 1);
    assert.equal(report.roots[0].totalBytes, statfsSync(root).blocks * statfsSync(root).bsize);
    assert(report.roots[0].freeInodes > 0);
    assert.equal(report.roots[0].physicalTreeBytes, null);
    assert.equal(report.roots[4].state, 'unavailable');
    assert.equal(report.worker.state, 'available');
    assert.equal(
      report.worker.records[0].Labels['org.mobyproject.buildkit.worker.snapshotter'],
      'native',
    );
    assert.equal(report.activeSolves.state, 'unavailable');
    assert.match(report.accounting, /Do not sum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed worker collection cannot become an overlayfs assertion or an empty success', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-report-failed-'));
  try {
    const client = join(root, 'buildctl');
    writeFileSync(client, '#!/bin/sh\necho partial-output\nexit 1\n', { mode: 0o755 });
    const result = spawnSync(
      'bash',
      [join(directory, 'storage-report.sh'), root, root, root, root, root],
      {
        env: { ...process.env, VERITY_BUILDCTL: client },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).worker, { state: 'unavailable', records: null });
    assert.equal(readFileSync(client, 'utf8').includes('exit 1'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer delivers bounded collection and updater rollback includes both storage units', () => {
  const installer = readFileSync(join(directory, 'install.sh'), 'utf8');
  const service = readFileSync(join(directory, 'verity-build-storage.service'), 'utf8');
  const timer = readFileSync(join(directory, 'verity-build-storage.timer'), 'utf8');
  const updater = readFileSync(
    new URL('../../../deploy/host/verity-host-builder', import.meta.url),
    'utf8',
  );
  for (const file of [
    'storage-report.sh',
    'publish-storage-report.sh',
    'verity-build-storage.service',
    'verity-build-storage.timer',
  ])
    assert(installer.includes(file), file);
  assert.match(service, /TimeoutStartSec=60/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(timer, /OnUnitInactiveSec=15s/);
  assert.match(updater, /VERITY_BUILD_STORAGE_UNIT_FILE/);
  assert.match(updater, /VERITY_BUILD_STORAGE_TIMER_FILE/);
  assert.match(updater, /systemctl disable --now verity-build-storage.timer/);
});

// Without storage-roots.conf the containerd root used to stay unavailable on
// every installed host, and the Server refused every build until an operator
// wrote the file by hand.
test('publisher takes the containerd root from the containerd Docker uses', () => {
  const work = mkdtempSync(join(tmpdir(), 'publish-storage-'));
  try {
    const root = join(work, 'containerd-root');
    spawnSync('mkdir', ['-p', root, join(work, 'bin'), join(work, 'libexec'), join(work, 'state')]);
    const script = (name, body) => {
      writeFileSync(join(work, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    // Records the roots the publisher hands to the collector.
    script('libexec/storage-report.sh', `printf '%s\\n' "$3"`);
    const publish = ({ dockerAddress, config, roots }) => {
      script(
        'bin/docker',
        `case "$*" in *Containerd.Address*) echo '${dockerAddress}';; *DockerRootDir*) echo /var/lib/docker;; *) exit 1;; esac`,
      );
      writeFileSync(join(work, 'config.toml'), config);
      script('bin/containerd', `cat '${join(work, 'config.toml')}'`);
      const result = spawnSync('bash', [join(directory, 'publish-storage-report.sh')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(work, 'bin')}:${process.env.PATH}`,
          VERITY_HOST_DIAGNOSTIC_DIR: join(work, 'state'),
          VERITY_BUILDKIT_LIBEXEC: join(work, 'libexec'),
          VERITY_BUILD_STORAGE_ROOTS: roots ?? join(work, 'absent.conf'),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(join(work, 'state', 'storage.json'), 'utf8').trim();
    };
    const v2 = `version = 3\nroot = '${root}'\n\n[plugins]\n  [plugins.'io.containerd.server.v1.grpc']\n    address = '/run/containerd/containerd.sock'\n  [plugins.'io.containerd.server.v1.ttrpc']\n    address = '/run/containerd/containerd.sock.ttrpc'\n`;
    const v1 = `version = 2\nroot = "${root}"\n\n[debug]\n  address = ""\n\n[grpc]\n  address = "/run/containerd/containerd.sock"\n`;
    for (const config of [v2, v1])
      assert.equal(publish({ dockerAddress: '/run/containerd/containerd.sock', config }), root);
    // Docker's own managed containerd is not the system configuration; never borrow its root.
    assert.equal(
      publish({ dockerAddress: '/var/run/docker/containerd/containerd.sock', config: v2 }),
      '/.verity-storage-unavailable',
    );
    // An operator's explicit root always wins.
    writeFileSync(join(work, 'roots.conf'), 'version=1\ncontainerdRoot=/srv/containerd\n');
    assert.equal(
      publish({
        dockerAddress: '/run/containerd/containerd.sock',
        config: v2,
        roots: join(work, 'roots.conf'),
      }),
      '/srv/containerd',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
