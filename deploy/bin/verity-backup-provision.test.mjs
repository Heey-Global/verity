import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
// CI uses a root container with only the mount capability; local non-root runs
// map their own UID first. Avoid uid_map writes in the root mount-only fixture.
const namespaceFlags = process.getuid?.() === 0 ? '-m' : '-rm';
const namespace = spawnSync('unshare', [namespaceFlags, 'true'], { encoding: 'utf8' });
const supported = namespace.status === 0;
if (process.env.CI && !supported)
  throw new Error(
    `Backup provisioning tests require isolated user and mount namespaces: ${namespace.stderr}`,
  );
const script = resolve('deploy/host/verity-backup-provision');
const image = `ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}`;
const systemctl = process.env.VERITY_TEST_SYSTEMCTL ?? 'systemctl';
const hasSystemctl = spawnSync(systemctl, ['--version']).status === 0;
if (process.env.CI && !hasSystemctl)
  throw new Error('systemctl is required for the peer PID regression');

test(
  'systemctl needs the manager peer visible in its PID namespace',
  { skip: !supported || !hasSystemctl },
  async () => {
    const root = mkdtempSync(join('/tmp', 'backup-peer-'));
    mkdirSync(join(root, 'systemd/system'), { recursive: true });
    // This socket deliberately rejects D-Bus authentication. Reaching that error
    // proves the real systemctl passed its earlier kernel peer-credential check;
    // it does not pretend to be a running systemd manager.
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', () => socket.end('REJECTED\r\n'));
    });
    await new Promise((resolve) => server.listen(join(root, 'systemd/private'), resolve));
    const run = (flags, chroot = false, ignoreChroot = false) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          'unshare',
          [
            flags,
            'bash',
            '-c',
            chroot
              ? `set -e
for path in usr lib lib64; do
  mkdir -p "$1/chroot/$path"
  mount --rbind "/$path" "$1/chroot/$path"
done
# Make the offline-root inode check deterministic even when the sandbox
# prevents access to the real /proc/1/root across user namespaces.
mkdir -p "$1/chroot/run" "$1/chroot/proc/1" "$1/chroot/host-root"
ln -sfn /host-root "$1/chroot/proc/1/root"
touch "$1/chroot/systemctl"
mount --bind "$(command -v "$2")" "$1/chroot/systemctl"
mount --bind "$1" "$1/chroot/run"
exec timeout 5 chroot "$1/chroot" /systemctl daemon-reload`
              : 'mount --bind "$1" /run && exec timeout 5 "$2" daemon-reload',
            'fixture',
            root,
            systemctl,
          ],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, LC_ALL: 'C', SYSTEMD_IGNORE_CHROOT: ignoreChroot ? '1' : '0' },
          },
        );
        let output = '';
        child.stdout.on('data', (bytes) => {
          output += bytes;
        });
        child.stderr.on('data', (bytes) => {
          output += bytes;
        });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, output }));
      });
    try {
      const isolated = await run(`${namespaceFlags}pf`);
      assert.equal(isolated.status, 1, isolated.output);
      assert.match(isolated.output, /Failed to connect to bus: No data available/);
      const shared = await run(namespaceFlags);
      assert.equal(shared.status, 1, shared.output);
      assert.match(shared.output, /Reload daemon failed:/);
      assert.doesNotMatch(shared.output, /Failed to connect to bus:/);
      // Host PID visibility with a container filesystem also trips systemctl's
      // offline-root heuristic. A successful no-op must not pass as provisioning.
      const offline = await run(namespaceFlags, true);
      assert.equal(offline.status, 0, offline.output);
      assert.match(offline.output, /chroot.*ignoring|ignoring.*chroot/i);
      const online = await run(namespaceFlags, true, true);
      assert.equal(online.status, 1, online.output);
      assert.match(online.output, /Reload daemon failed:/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test(
  'legacy provisioning preserves archives and credentials, retries and receipts only after success',
  { skip: !supported },
  async () => {
    const root = mkdtempSync(join('/tmp', 'backup-bootstrap-'));
    const state = join(root, 'state');
    const backup = join(root, 'archives');
    const bin = join(root, 'bin');
    for (const directory of [
      state,
      backup,
      bin,
      join(root, 'run/systemd/system'),
      join(root, 'etc'),
    ])
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const watcher = createServer();
    await new Promise((resolve) => watcher.listen(join(root, 'run/systemd/private'), resolve));
    try {
      const password = 'c'.repeat(64);
      const installation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      writeFileSync(join(state, 'backup-dir'), backup);
      writeFileSync(join(state, 'backup-postgres-password'), password, { mode: 0o600 });
      writeFileSync(join(state, 'installation-id'), installation);
      writeFileSync(join(backup, 'existing-snapshot'), 'preserve me');
      writeFileSync(
        join(bin, 'docker'),
        '#!/bin/bash\ncat >"$FIXTURE/sql"\nexit "${SQL_STATUS:-0}"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(bin, 'systemctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
      writeFileSync(join(root, 'etc/group'), 'root:x:0:\n');
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURE: root,
        VERITY_STATE_DIR: state,
        VERITY_BACKUP_DIR: backup,
        VERITY_BACKUP_IMAGE: image,
        VERITY_BACKUP_POSTGRES: 'b'.repeat(64),
        VERITY_SERVER_UID: '0',
        VERITY_SERVER_GID: '0',
        VERITY_BACKUP_IDENTITY_DIR: join(root, 'requests'),
        VERITY_HOST_RUNTIME_LIBEXEC: join(root, 'libexec'),
        VERITY_SYSTEMD_UNIT_DIR: join(root, 'units'),
      };
      const run = (extra = {}) =>
        spawnSync(
          'unshare',
          [
            namespaceFlags,
            'bash',
            '-c',
            'mount --bind "$1/etc" /etc && mount --bind "$1/run" /run && exec bash "$2"',
            'fixture',
            root,
            script,
          ],
          { env: { ...env, ...extra }, encoding: 'utf8' },
        );
      const failed = run({ SQL_STATUS: '1' });
      assert.notEqual(failed.status, 0);
      assert.equal(existsSync(join(state, 'backup-provisioning-version')), false);
      for (let i = 0; i < 2; i++) {
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr.includes(password), false);
      }
      assert.equal(readFileSync(join(state, 'backup-provisioning-version'), 'utf8'), '1\n');
      assert.equal(readFileSync(join(state, 'installation-id'), 'utf8').trim(), installation);
      assert.equal(readFileSync(join(state, 'backup-postgres-password'), 'utf8').trim(), password);
      assert.equal(readFileSync(join(backup, 'existing-snapshot'), 'utf8'), 'preserve me');
      assert.match(readFileSync(join(root, 'sql'), 'utf8'), /default_transaction_read_only = on/);
      assert.equal(existsSync(join(root, 'requests/recipient.json')), false);
      mkdirSync(join(state, 'restore'));
      writeFileSync(
        join(state, 'restore/job'),
        JSON.stringify({ phase: 'accepted', id: 'restore-fixture' }),
      );
      assert.notEqual(run().status, 0, 'acceptance without activation must block provisioning');
      writeFileSync(join(state, 'restore/activation-complete'), 'restore-fixture');
      assert.equal(run().status, 0, 'a completed restore must remain upgradeable');
      writeFileSync(join(state, 'backup-dir'), '/different');
      assert.notEqual(run().status, 0);
    } finally {
      await new Promise((resolve) => watcher.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('the runtime image installs the checkpoint parser used by provisioning', () => {
  const helper = readFileSync(script, 'utf8');
  assert.match(helper, /\bjq -e/);
  const runtime = readFileSync(resolve('deploy/Dockerfile'), 'utf8').split(
    /FROM[^\n]+ AS runtime\n/,
  )[1];
  assert.ok(runtime, 'runtime stage must be present');
  const packages = runtime.match(/apt-get install[^;]+/)?.[0].split(/\s+/) ?? [];
  assert.ok(
    packages.includes('jq'),
    'restore and rotation checkpoints require jq in the runtime stage',
  );
});
