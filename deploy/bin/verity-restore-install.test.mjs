import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

test('restore shell sends credentials only over stdin, uses explicit selection and keeps the trial off canonical volumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'restore-shell-'));
  const state = join(root, 'state');
  const source = join(root, "copied backup'$(false)");
  const bin = join(root, 'bin');
  const log = join(root, 'docker.log');
  await Promise.all([mkdir(state, { mode: 0o700 }), mkdir(source), mkdir(bin)]);
  await mkdir(join(state, 'restore'), { mode: 0o700 });
  const id = '11111111-1111-4111-8111-111111111111';
  const repository = '22222222-2222-4222-8222-222222222222-r1';
  const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args[0] === 'volume') process.exit(1);
if(args[0] !== 'run') process.exit(2);
let bytes = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => bytes += chunk);
process.stdin.on('end', () => {
 const input = JSON.parse(bytes); const c = input.configuration;
 if(input.recoveryKey !== 'private-recovery' || input.masterPassword !== 'private-master') process.exit(3);
 let job;
 if(c.action === 'begin') job = { id: '${id}', selection: c.selection, phase: 'verifying' };
 else { job = JSON.parse(fs.readFileSync(${JSON.stringify(join(state, 'restore/job'))})); const phases = ['verifying','verified','staged','trial']; job.phase = phases[phases.indexOf(job.phase)+1]; }
 fs.writeFileSync(${JSON.stringify(join(state, 'restore/job'))}, JSON.stringify(job), {mode:0o600});
 console.log(JSON.stringify(job));
});
`;
  await writeFile(join(bin, 'docker'), docker, { mode: 0o755 });
  const script = `set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
read_state() { if [[ -f $1 ]]; then cat "$1"; fi; }
stat() { if [[ $1 = -c && $2 = %u ]]; then printf '0\\n'; else command stat "$@"; fi; }
valid_server_image() { [[ $1 = ghcr.io/heey-global/verity/verity-server@sha256:* ]]; }
verity_pairing_ipv4_addresses() { printf '192.0.2.1\\n'; }
STATE_DIR=$1
PROJECT_PATH="$STATE_DIR/compose-project"
SERVER_REPO=ghcr.io/heey-global/verity/verity-server
MANAGED_DEPLOYMENT_VOLUME=verity-managed-deployment
opt_restore=$2
opt_restore_action=trial
opt_restore_repository=${repository}
opt_restore_snapshot=7
opt_restore_kind=scheduled
opt_restore_new_identity=0
opt_restore_keep_none=0
opt_restore_secrets_stdin=1
opt_restore_keep_devices=()
opt_backup_dir=''
opt_project=''
opt_image=ghcr.io/heey-global/verity/verity-server@sha256:${'a'.repeat(64)}
opt_tag=latest
restore_activation=0
source "$3"
verity_restore_install
`;
  try {
    const child = spawn(
      'bash',
      ['-c', script, 'restore-shell', state, source, resolve('deploy/bin/verity-restore-install')],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          VERITY_SYSTEMD_RUN_DIR: join(root, 'no-systemd'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.stdin.end('private-recovery\nprivate-master\n');
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(code, 0, output);
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((args) => args[0] === 'run').length, 4);
    assert.ok(!JSON.stringify(calls).includes('private-recovery'));
    assert.ok(!JSON.stringify(calls).includes('private-master'));
    assert.ok(!JSON.stringify(calls).includes('dst=/restore-live'));
    assert.ok(JSON.stringify(calls).includes(`src=${source},dst=${source},readonly`));
    const job = JSON.parse(await readFile(join(state, 'restore/job'), 'utf8'));
    assert.deepEqual(job.selection, {
      source,
      repository,
      sequence: 7,
      kind: 'scheduled',
      newIdentity: false,
    });
    assert.equal(job.phase, 'trial');
    const before = await readFile(log, 'utf8');
    const mismatch = spawn(
      'bash',
      [
        '-c',
        script.replace('opt_restore_snapshot=7', 'opt_restore_snapshot=8'),
        'restore-shell',
        state,
        source,
        resolve('deploy/bin/verity-restore-install'),
      ],
      {
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          VERITY_SYSTEMD_RUN_DIR: join(root, 'no-systemd'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let rejection = '';
    mismatch.stderr.on('data', (chunk) => (rejection += chunk));
    mismatch.stdin.end('private-recovery\nprivate-master\n');
    assert.equal(await new Promise((resolve) => mismatch.once('exit', resolve)), 1);
    assert.match(rejection, /snapshot differs from the active restore checkpoint/);
    assert.equal(await readFile(log, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
