#!/usr/bin/env node
// Deliberately offline: no daemon cancellation API proves arbitrary Engine
// imports stopped. A verified host reboot is the conservative recovery proof.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const units = ['verity-buildkit.service', 'docker.service', 'docker.socket', 'containerd.service'];
const refuse = (message) => {
  throw new Error(`Reconciliation refused: ${message}. No reservation was released.`);
};

/**
 * @param {Record<string, unknown>} record
 * @param {{identity: string, bootId: string}} host
 * @param {Record<string, Record<string, string>>} services
 * @param {string[]} executables
 */
export function verifyOfflineEvidence(record, host, services, executables) {
  if (
    record === null ||
    typeof record !== 'object' ||
    record.version !== 1 ||
    typeof record.operation !== 'string' ||
    typeof record.hostIdentity !== 'string' ||
    typeof record.hostBootId !== 'string' ||
    !['build-export', 'image-import'].includes(record.operation) ||
    !/^[a-f0-9]{64}$/.test(record.hostIdentity ?? '') ||
    !/^[a-f0-9-]{36}$/.test(record.hostBootId ?? '')
  )
    refuse('invalid remote operation record');
  if (record.hostIdentity !== host.identity) refuse('this is not the recorded build host');
  if (record.hostBootId === host.bootId) refuse('the recorded host boot has not ended');
  if (
    services['emergency.target']?.ActiveState !== 'active' ||
    services['multi-user.target']?.ActiveState !== 'inactive' ||
    services['sockets.target']?.ActiveState !== 'inactive'
  )
    refuse('boot into systemd emergency.target before offline reconciliation');
  for (const unit of units) {
    const state = services[unit];
    if (
      !state ||
      !['inactive', 'failed'].includes(state.ActiveState) ||
      (unit.endsWith('.service') && state.MainPID !== '0')
    )
      refuse(`${unit} must be stopped`);
  }
  if (
    executables.some((name) =>
      /node|verity|buildkit|buildctl|docker|containerd|runsc|runc|devcontainer/i.test(name),
    )
  )
    refuse('Server or container runtime processes still exist');
}

/** @param {string | undefined} attempt */
export function reconcile(attempt) {
  if (process.getuid?.() !== 0) refuse('run as root on the build host');
  if (readFileSync('/proc/1/comm', 'utf8').trim() !== 'systemd')
    refuse('run in the host PID namespace');
  if (
    !attempt ||
    !attempt.startsWith('/') ||
    realpathSync(attempt) !== resolve(attempt) ||
    !/^attempt-[A-Za-z0-9_-]+$/.test(basename(attempt)) ||
    basename(dirname(attempt)) !== 'build-storage'
  )
    refuse('supply one canonical build-storage/attempt-* directory');
  const marker = join(attempt, 'remote-operation.json');
  if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink())
    refuse('invalid reservation file');
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(marker, 'utf8'));
  const record = /** @type {Record<string, unknown>} */ (parsed);
  /** @type {Record<string, Record<string, string>>} */
  const services = {};
  for (const unit of [...units, 'emergency.target', 'multi-user.target', 'sockets.target']) {
    const output = execFileSync(
      'systemctl',
      ['show', unit, '--property=UnitFileState,ActiveState,MainPID'],
      { encoding: 'utf8', timeout: 5000 },
    );
    services[unit] = {};
    for (const line of output.trim().split('\n')) {
      const index = line.indexOf('=');
      if (index > 0) services[unit][line.slice(0, index)] = line.slice(index + 1);
    }
  }
  const executables = [];
  for (const pid of readdirSync('/proc').filter(
    (name) => /^\d+$/.test(name) && Number(name) !== process.pid,
  )) {
    try {
      executables.push(basename(readlinkSync(`/proc/${pid}/exe`)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  verifyOfflineEvidence(
    record,
    {
      identity: createHash('sha256').update(readFileSync('/etc/machine-id')).digest('hex'),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    },
    services,
    executables,
  );
  // Emergency mode keeps normal services and socket activation offline.
  // No project clone/volume, image, snapshot or other attempt is selected.
  rmSync(attempt, { recursive: true });
  const fd = openSync(dirname(attempt), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  console.log(
    'Verified previous host boot ended; released only the selected owned attempt. Host remains in emergency mode.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--attempt')
      refuse(
        'usage: node scripts/build-storage-reconcile.mjs --attempt /absolute/build-storage/attempt-ID',
      );
    reconcile(process.argv[3]);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
