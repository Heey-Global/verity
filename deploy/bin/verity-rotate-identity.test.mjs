import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';

const installer = resolve('deploy/bin/verity-rotate-identity');
const helper = resolve('deploy/bin/verity-pairing-material');
const server = 'a'.repeat(64),
  updater = 'b'.repeat(64),
  postgres = 'c'.repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'identity-rotation-'));
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  await writeFile(join(state, 'compose-project'), 'verity\n');
  await writeFile(join(state, 'deployment-id'), 'test-deployment\n');
  const environment = {
    ...process.env,
    OPENSSL_CONF: '/dev/null',
    VERITY_PAIRING_IPS: '127.0.0.1',
    VERITY_STATE_DIR: state,
    VERITY_SERVER_UID: String(process.getuid()),
    VERITY_SERVER_GID: String(process.getgid()),
    ROTATION_SCRIPT: installer,
    PAIRING_SCRIPT: helper,
    ROTATION_LOG: join(root, 'log'),
    VERITY_SYSTEMD_RUN_DIR: join(root, 'no-systemd'),
    VERITY_BACKUP_IDENTITY_DIR: join(root, 'no-recipient'),
  };
  const prefix = `set -euo pipefail
id() { printf '0\\n'; }
chown() { :; }
sync() { :; }
stat() { if [[ $1 = -c && $2 = %u ]]; then printf '0\\n'; else command stat "$@"; fi; }
install() { local -a args=(); while [[ $# -gt 0 ]]; do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; command install "\${args[@]}"; }
export -f id chown stat
`;
  async function run(body, extra = {}) {
    const child = spawn('/bin/bash', ['-c', prefix + body], { env: { ...environment, ...extra } });
    let output = '';
    child.stdout.on('data', (bytes) => (output += bytes));
    child.stderr.on('data', (bytes) => (output += bytes));
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { code, output };
  }
  const initial = await run('"$PAIRING_SCRIPT"');
  assert.equal(initial.code, 0, initial.output);
  const oldCa = new X509Certificate(await readFile(join(state, 'tls-ca-cert.pem')));
  const oldKey = await readFile(join(state, 'pairing-identity.pem'));
  const body = `
die() { printf '%s\\n' "$*" >&2; exit 1; }
note() { printf '%s\\n' "$*"; }
read_state() { cat "$1"; }
docker() {
 printf '%s\\n' "$*" >>"$ROTATION_LOG"
 if [[ $1 = ps ]]; then
   if [[ $* = *label=com.docker.compose.service=postgres* ]]; then printf '${postgres}\\n';
   elif [[ $* = *service=verity-updater* ]]; then printf '${updater}\\n';
   else printf '${server}\\n${updater}\\n'; fi
 elif [[ $1 = inspect ]]; then printf '%s\\n' '{"Name":"unless-stopped","MaximumRetryCount":0}'
 elif [[ $1 = exec ]]; then
   cat >>"$ROTATION_LOG"
   [[ \${FAIL_PHASE:-} != revoke ]] || return 7
 elif [[ $1 = start && \${FAIL_PHASE:-} = start ]]; then return 8
 fi
}
systemctl() {
 printf 'systemctl %s\\n' "$*" >>"$ROTATION_LOG"
 if [[ $* = 'start verity-backup-identity.service' && \${FAIL_PHASE:-} = helper ]]; then return 10; fi
}
flock() {
 if [[ $1 = --exclusive && -n \${ROTATION_HELPER_ATTEMPT:-} ]]; then printf attempt >"$ROTATION_HELPER_ATTEMPT"; fi
 command flock "$@"
}
mv() { if [[ \${FAIL_PHASE:-} = publish && $* = *tls-key.pem* ]]; then return 9; fi; command mv "$@"; }
opt_restart_rotation=\${RESTART_ROTATION:-0}
STATE_DIR=$VERITY_STATE_DIR
PROJECT_PATH="$STATE_DIR/compose-project"
ID_PATH="$STATE_DIR/deployment-id"
script_dir=$(dirname "$PAIRING_SCRIPT")
exec 8>"$STATE_DIR/.verity-install.lock"
flock -n 8 || die 'installer locked'
source "$ROTATION_SCRIPT"
verity_rotate_identity
`;
  return {
    root,
    state,
    oldCa,
    oldKey,
    run: (extra) => run(body, extra),
    clean: () => rm(root, { recursive: true, force: true }),
  };
}

for (const failure of ['prepare', 'revoke', 'publish', 'start']) {
  test(`rotation resumes after ${failure} failure without restoring old credentials`, async () => {
    const f = await fixture();
    try {
      const failed = await f.run({
        FAIL_PHASE: failure,
        ...(failure === 'prepare' ? { VERITY_PAIRING_HOST: 'invalid/host' } : {}),
      });
      assert.notEqual(failed.code, 0, failed.output);
      const checkpoint = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
      assert.equal(
        checkpoint.phase,
        { prepare: 'fencing', revoke: 'prepared', publish: 'revoked', start: 'published' }[failure],
      );
      let log = await readFile(join(f.root, 'log'), 'utf8');
      if (failure !== 'start') assert.ok(!log.includes('start '), log);
      const result = await f.run();
      assert.equal(result.code, 0, result.output);
      const current = new X509Certificate(await readFile(join(f.state, 'tls-ca-cert.pem')));
      assert.notEqual(current.fingerprint256, f.oldCa.fingerprint256);
      assert.notDeepEqual(await readFile(join(f.state, 'pairing-identity.pem')), f.oldKey);
      assert.equal(
        (await readFile(join(f.state, 'retired-identity-ca-sha256'), 'utf8')).trim().split('\n')[0],
        createHash('sha256').update(f.oldCa.raw).digest('hex'),
      );
      assert.equal(
        JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
        'complete',
      );
      log = await readFile(join(f.root, 'log'), 'utf8');
      const sqlCount = log.split('DELETE FROM auth_tokens;').length - 1;
      assert.equal(sqlCount, failure === 'revoke' ? 2 : 1);
      assert.ok(
        log.indexOf(`update --restart=no ${updater}`) < log.indexOf(`stop --time 60 ${updater}`),
      );
      assert.ok(log.includes(`update --restart=unless-stopped ${server}`));
      assert.ok(
        log.indexOf(`update --restart=no ${server}`) < log.indexOf('DELETE FROM auth_tokens;'),
      );
      assert.ok(log.indexOf(`stop --time 60 ${updater}`) < log.indexOf('DELETE FROM auth_tokens;'));
      const repeat = await f.run();
      assert.equal(repeat.code, 0, repeat.output);
      assert.equal(
        (await readFile(join(f.root, 'log'), 'utf8')).split('DELETE FROM auth_tokens;').length - 1,
        sqlCount,
      );
    } finally {
      await f.clean();
    }
  });
}

test('rotation refuses a substituted publication target and leaves runtime stopped', async () => {
  const f = await fixture();
  try {
    const first = await f.run({ FAIL_PHASE: 'publish' });
    assert.notEqual(first.code, 0);
    await rm(join(f.state, 'tls-key.pem'));
    const unrelated = join(f.root, 'unrelated');
    await writeFile(unrelated, 'must survive');
    await symlink(unrelated, join(f.state, 'tls-key.pem'));
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /unsafe identity publication target/);
    assert.equal(await readFile(unrelated, 'utf8'), 'must survive');
    assert.ok(!(await readFile(join(f.root, 'log'), 'utf8')).includes('start '));
  } finally {
    await f.clean();
  }
});

test('installer and helper locks exclude concurrent identity writers', async () => {
  const f = await fixture();
  const holder = spawn(
    'flock',
    [
      '--exclusive',
      join(f.state, '.verity-install.lock'),
      '/bin/bash',
      '-c',
      'printf ready; read -r release',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /installer locked/);
  } finally {
    holder.stdin.end('release\n');
    await new Promise((resolve) => holder.once('close', resolve));
    await f.clean();
  }
});

test('corrupt replacement material cannot publish or restart after credential revocation', async () => {
  const f = await fixture();
  try {
    await f.run({ FAIL_PHASE: 'publish' });
    await writeFile(join(f.state, 'identity-rotation/material/tls-ca-cert.pem'), 'corrupt');
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /replacement TLS certificate does not match CA/);
    assert.ok(!(await readFile(join(f.root, 'log'), 'utf8')).includes('start '));
    assert.equal(
      JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
      'revoked',
    );
  } finally {
    await f.clean();
  }
});

test('another destructive rotation requires an explicit restart and retains retirement history', async () => {
  const f = await fixture();
  try {
    const initial = await f.run();
    assert.equal(initial.code, 0, initial.output);
    const first = new X509Certificate(await readFile(join(f.state, 'tls-ca-cert.pem')));
    const repeat = await f.run({ RESTART_ROTATION: '1' });
    assert.equal(repeat.code, 0, repeat.output);
    const second = new X509Certificate(await readFile(join(f.state, 'tls-ca-cert.pem')));
    assert.notEqual(second.fingerprint256, first.fingerprint256);
    const retired = (await readFile(join(f.state, 'retired-identity-ca-sha256'), 'utf8'))
      .trim()
      .split('\n');
    assert.deepEqual(
      retired,
      [f.oldCa, first].map((ca) => createHash('sha256').update(ca.raw).digest('hex')),
    );
  } finally {
    await f.clean();
  }
});

test('a concurrent CA helper must release its lock before rotation writes any runtime state', async () => {
  const f = await fixture();
  const holder = spawn(
    'flock',
    [
      '--exclusive',
      join(f.state, '.backup-identity.lock'),
      '/bin/bash',
      '-c',
      'printf ready; read -r release',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let rotation;
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });
    let settled = false;
    const attempt = join(f.root, 'helper-lock-attempt');
    rotation = f.run({ ROTATION_HELPER_ATTEMPT: attempt }).then((result) => {
      settled = true;
      return result;
    });
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        await readFile(attempt);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(settled, false);
    await assert.rejects(readFile(join(f.root, 'log')), { code: 'ENOENT' });
  } finally {
    holder.stdin.end('release\n');
    await new Promise((resolve) => holder.once('close', resolve));
    if (rotation) {
      const result = await rotation;
      assert.equal(result.code, 0, result.output);
    }
    await f.clean();
  }
});

test('failed CA backup publication is retried after irreversible rotation without deleting new pairings', async () => {
  const f = await fixture();
  try {
    const systemd = join(f.root, 'systemd');
    const requests = join(f.root, 'requests');
    await mkdir(systemd);
    await mkdir(requests);
    await writeFile(join(requests, 'recipient.json'), '{}');
    const environment = { VERITY_SYSTEMD_RUN_DIR: systemd, VERITY_BACKUP_IDENTITY_DIR: requests };
    const failed = await f.run({ ...environment, FAIL_PHASE: 'helper' });
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /CA backup publication failed/);
    assert.equal(
      JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
      'complete',
    );
    const retried = await f.run(environment);
    assert.equal(retried.code, 0, retried.output);
    const log = await readFile(join(f.root, 'log'), 'utf8');
    assert.equal(log.split('DELETE FROM auth_tokens;').length - 1, 1);
    assert.equal(log.split('systemctl start verity-backup-identity.service').length - 1, 2);
  } finally {
    await f.clean();
  }
});
