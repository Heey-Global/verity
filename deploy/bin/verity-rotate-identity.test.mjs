import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createDevicePairingManager } from '../../packages/server/src/device-pairing.ts';

const installer = resolve('deploy/bin/verity-rotate-identity');
const helper = resolve('deploy/bin/verity-pairing-material');
const server = 'a'.repeat(64),
  updater = 'b'.repeat(64),
  postgres = 'c'.repeat(64),
  replacement = 'd'.repeat(64);
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
    ROTATION_RACE_FILE: join(root, 'replacement-created'),
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
   if [[ $2 = -q && $* = *service=verity-updater* && \${FAIL_PHASE:-} = updater-inventory ]]; then return 8; fi
   if [[ $2 = -aq && $* != *--filter* && \${FAIL_PHASE:-} = inventory ]]; then return 9; fi
   if [[ ( \${RACE_REPLACE:-0} = 1 || \${RACE_RESTART:-0} = 1 ) && -f $ROTATION_RACE_FILE ]]; then
     if [[ $2 = -aq && $* != *--filter* ]]; then printf '${updater}\\n${replacement}\\n';
     elif [[ $* = *service=verity-updater* ]]; then if [[ $2 = -aq || \${RACE_RESTART:-0} = 1 || -f $ROTATION_RACE_FILE.updater-running ]]; then printf '${updater}\\n'; fi;
     else printf '${replacement}\\n'; if [[ \${RACE_RESTART:-0} = 1 || -f $ROTATION_RACE_FILE.updater-running ]]; then printf '${updater}\\n'; fi; fi
     return
   fi
   if [[ $* = *label=com.docker.compose.service=postgres* ]]; then printf '${postgres}\\n';
   elif [[ $* = *service=verity-updater* ]]; then printf '${updater}\\n';
   else printf '${server}\\n${updater}\\n'; fi
 elif [[ ( \${RACE_REPLACE:-0} = 1 || \${RACE_RESTART:-0} = 1 ) && -f $ROTATION_RACE_FILE && $* = *${server}* ]]; then return 44
 elif [[ $1 = stop && $* = *${updater}* && \${RACE_REPLACE:-0} = 1 ]]; then touch "$ROTATION_RACE_FILE"
 elif [[ $1 = start && $* = *${updater}* ]]; then
   [[ \${FAIL_PHASE:-} != updater-start ]] || return 8
   touch "$ROTATION_RACE_FILE.updater-running"
   if [[ \${RACE_RESTART:-0} = 1 ]]; then touch "$ROTATION_RACE_FILE"; fi
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
mv() { if [[ \${FAIL_PHASE:-} = inventory-save && -f $ROTATION_RACE_FILE && $* = *identity-rotation/checkpoint ]]; then return 45; fi; if [[ \${FAIL_PHASE:-} = publish && $* = *tls-key.pem* ]]; then return 9; fi; command mv "$@" || return
 if [[ \${@: -1} = *identity-rotation/checkpoint ]]; then printf 'checkpoint %s\\n' "$(jq -r .phase "\${@: -1}")" >>"$ROTATION_LOG"; fi
}
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

for (const interrupted of [false, true]) {
  test(`rotation reconciles an updater-removed Server and replacement${interrupted ? ' after interrupted inventory persistence' : ''}`, async () => {
    const f = await fixture();
    try {
      if (interrupted) {
        const failed = await f.run({ RACE_REPLACE: '1', FAIL_PHASE: 'inventory-save' });
        assert.notEqual(failed.code, 0);
        const pending = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
        assert.equal(pending.phase, 'fencing');
        assert.ok(pending.containers.includes(server));
      }
      const result = await f.run({ RACE_REPLACE: '1' });
      assert.equal(result.code, 0, result.output);
      const checkpoint = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
      assert.equal(checkpoint.phase, 'complete');
      assert.deepEqual(checkpoint.containers, [updater, replacement]);
      assert.deepEqual(Object.keys(checkpoint.policies).sort(), [updater, replacement]);
      const log = await readFile(join(f.root, 'log'), 'utf8');
      assert.ok(log.includes(`update --restart=no ${replacement}`));
      assert.ok(log.includes(`start ${replacement}`));
      assert.ok(log.includes(`start ${updater}`));
      assert.ok(!log.includes(`update --restart=no ${server}`));
      assert.ok(!log.includes(`stop --time 60 ${server}`));
      assert.ok(!log.includes(`start ${server}`));
    } finally {
      await f.clean();
    }
  });
}

test('Docker inventory failure cannot be mistaken for proof that recorded runtime disappeared', async () => {
  const f = await fixture();
  try {
    const failed = await f.run({ FAIL_PHASE: 'inventory' });
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /Docker did not confirm container existence/);
    const checkpoint = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
    assert.equal(checkpoint.phase, 'fencing');
    assert.deepEqual(checkpoint.containers, [server, updater]);
    const log = await readFile(join(f.root, 'log'), 'utf8');
    assert.ok(!log.includes('DELETE FROM auth_tokens;'));
    assert.ok(!log.includes('start '));
    const retried = await f.run();
    assert.equal(retried.code, 0, retried.output);
  } finally {
    await f.clean();
  }
});

for (const interrupted of [false, true]) {
  test(`expired pairing invitation refresh preserves keys and new pairings${interrupted ? ' after interrupted publication' : ''}`, async () => {
    const f = await fixture();
    try {
      const initial = await f.run(interrupted ? { FAIL_PHASE: 'start' } : {});
      assert.equal(initial.code, interrupted ? 1 : 0, initial.output);
      const names = [
        'pairing-identity.pem',
        'tls-key.pem',
        'tls-cert.pem',
        'tls-ca-key.pem',
        'tls-ca-cert.pem',
      ];
      const before = await Promise.all(names.map((name) => readFile(join(f.state, name))));
      const previousCode = await readFile(join(f.state, 'pairing-code'), 'utf8');
      await writeFile(join(f.state, 'pairing-expires-at'), '2000-01-01T00:00:00.000Z');
      const resumed = await f.run();
      assert.equal(resumed.code, 0, resumed.output);
      const after = await Promise.all(names.map((name) => readFile(join(f.state, name))));
      assert.deepEqual(after, before);
      const invitation = JSON.parse(
        Buffer.from(
          (await readFile(join(f.state, 'pairing-uri'), 'utf8')).split('payload=')[1],
          'base64url',
        ).toString(),
      );
      assert.ok(Date.parse(invitation.expiresAt) > Date.now() + 5 * 60_000);
      assert.notEqual(invitation.code, previousCode.trim());
      const consumed = new Set();
      const pairing = createDevicePairingManager({
        privateKeyPem: after[0].toString(),
        pairingCode: invitation.code,
        expiresAt: invitation.expiresAt,
        loadConsumedCodeHash: () => [...consumed],
        storeConsumedCodeHash: (hash) => {
          if (consumed.has(hash)) return false;
          consumed.add(hash);
          return true;
        },
      });
      assert.deepEqual(pairing.identity(), {
        serverId: invitation.serverId,
        identityKey: invitation.identityKey,
      });
      assert.throws(() => pairing.redeem(previousCode.trim()));
      assert.ok(pairing.redeem(invitation.code).bootstrapToken);

      assert.equal(invitation.code, (await readFile(join(f.state, 'pairing-code'), 'utf8')).trim());
      const log = await readFile(join(f.root, 'log'), 'utf8');
      assert.equal(log.split('DELETE FROM auth_tokens;').length - 1, 1);
      assert.equal(
        JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
        'complete',
      );
    } finally {
      await f.clean();
    }
  });
}

test('failed updater inventory cannot silently skip fencing before identity publication', async () => {
  const f = await fixture();
  try {
    const failed = await f.run({ FAIL_PHASE: 'updater-inventory' });
    assert.notEqual(failed.code, 0);
    assert.match(failed.output, /runtime fencing is unconfirmed/);
    const pending = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
    assert.equal(pending.phase, 'fencing');
    const log = await readFile(join(f.root, 'log'), 'utf8');
    assert.ok(!log.includes('DELETE FROM auth_tokens;'));
    assert.ok(!log.includes('start '));
    assert.ok(!log.includes('stop --time 60'));
    const retry = await f.run();
    assert.equal(retry.code, 0, retry.output);
  } finally {
    await f.clean();
  }
});

test('updater restart can replace the Server only after other policies and completion are durable', async () => {
  const f = await fixture();
  try {
    const result = await f.run({ RACE_RESTART: '1' });
    assert.equal(result.code, 0, result.output);
    const log = await readFile(join(f.root, 'log'), 'utf8');
    const restorePolicy = log.indexOf(`update --restart=unless-stopped ${server}`);
    const complete = log.indexOf('checkpoint complete');
    const startUpdater = log.indexOf(`start ${updater}`);
    assert.ok(restorePolicy >= 0 && restorePolicy < complete, log);
    assert.ok(complete < startUpdater, log);
    assert.ok(!log.slice(startUpdater).includes(server), log);
    const before = log.split('DELETE FROM auth_tokens;').length - 1;
    const repeat = await f.run({ RACE_RESTART: '1' });
    assert.equal(repeat.code, 0, repeat.output);
    const retriedLog = await readFile(join(f.root, 'log'), 'utf8');
    assert.equal(retriedLog.split('DELETE FROM auth_tokens;').length - 1, before);
    assert.ok(!retriedLog.slice(log.length).includes(server));
  } finally {
    await f.clean();
  }
});

test('completed checkpoint resumes failed updater start without repeating Server or device operations', async () => {
  const f = await fixture();
  try {
    const first = await f.run({ FAIL_PHASE: 'updater-start' });
    assert.notEqual(first.code, 0);
    assert.match(first.output, /completion is durable/);
    assert.equal(
      JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
      'complete',
    );
    const before = await readFile(join(f.root, 'log'), 'utf8');
    const retry = await f.run({ RACE_RESTART: '1' });
    assert.equal(retry.code, 0, retry.output);
    const log = await readFile(join(f.root, 'log'), 'utf8');
    assert.equal(log.split(`start ${server}`).length - 1, 1);
    assert.equal(log.split(`start ${updater}`).length - 1, 2);
    await readFile(join(f.root, 'replacement-created'));
    assert.equal(log.split('DELETE FROM auth_tokens;').length - 1, 1);
    assert.ok(!log.slice(before.length).includes(server));
  } finally {
    await f.clean();
  }
});

test('published retry discovers a Server replaced by an earlier updater restart attempt', async () => {
  const f = await fixture();
  try {
    const first = await f.run({ FAIL_PHASE: 'start' });
    assert.notEqual(first.code, 0);
    assert.equal(
      JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint'))).phase,
      'published',
    );
    await writeFile(join(f.root, 'replacement-created'), 'existing updater replaced old Server');
    const retry = await f.run({ RACE_RESTART: '1' });
    assert.equal(retry.code, 0, retry.output);
    const completed = JSON.parse(await readFile(join(f.state, 'identity-rotation/checkpoint')));
    assert.equal(completed.phase, 'complete');
    assert.deepEqual(completed.containers, [updater, replacement]);
    assert.ok(!Object.hasOwn(completed.policies, server));
    const log = await readFile(join(f.root, 'log'), 'utf8');
    assert.equal(log.split('DELETE FROM auth_tokens;').length - 1, 1);
    assert.ok(log.includes(`start ${replacement}`));
  } finally {
    await f.clean();
  }
});
