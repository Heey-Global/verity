import { spawn } from 'node:child_process';
import { chmod, chown, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.getuid?.() !== 0) {
  throw new Error('runner forgery boundary test must run as root in its isolated container');
}

const AGENT_UID = 1000;
const AGENT_GID = 1000;
const RUNNER_UID = 1101;
const RUNTIME_GID = 1101;
const root = await mkdtemp(join(tmpdir(), 'verity-runner-forgery-'));
const runtime = join(root, 'runtime');
const turns = join(runtime, 'turns');
const turn = join(turns, 'known-turn');
const eventFile = join(turn, 'events.jsonl');
const journalFile = join(turn, 'control.sock.journal');
const controlSocket = join(turn, 'control.sock');
const originalEvent = '{"kind":"event","trusted":true}\n';
const originalJournal = '{"state":"received","trusted":true}\n';
let connections = 0;
let listening = false;
const server = createServer((socket) => {
  connections += 1;
  socket.destroy();
});

const childScript = String.raw`
  const { appendFileSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
  const { createConnection } = require('node:net');
  const status = readFileSync('/proc/self/status', 'utf8');
  const statusField = (name) => new RegExp('^' + name + ':\\s*(\\S+)$', 'mi').exec(status)?.[1];
  const attempt = (fn) => { try { fn(); return 'succeeded'; } catch (error) { return error.code; } };
  const results = {
    uid: process.getuid(),
    gid: process.getgid(),
    groups: process.getgroups(),
    capInh: statusField('CapInh'),
    capPrm: statusField('CapPrm'),
    capEff: statusField('CapEff'),
    capBnd: statusField('CapBnd'),
    capAmb: statusField('CapAmb'),
    noNewPrivs: statusField('NoNewPrivs'),
    listTurns: attempt(() => readdirSync(process.env.FORGERY_TURNS)),
    appendEvent: attempt(() => appendFileSync(process.env.FORGERY_EVENT, '{"forged":true}\n')),
    appendJournal: attempt(() => appendFileSync(process.env.FORGERY_JOURNAL, '{"forged":true}\n')),
    createTurnFile: attempt(() => writeFileSync(process.env.FORGERY_CREATED, 'forged')),
  };
  const socket = createConnection(process.env.FORGERY_SOCKET);
  socket.once('connect', () => { results.connectControl = 'succeeded'; socket.destroy(); done(); });
  socket.once('error', (error) => { results.connectControl = error.code; done(); });
  const timeout = setTimeout(() => { results.connectControl = 'timeout'; socket.destroy(); done(); }, 2000);
  function done() { clearTimeout(timeout); process.stdout.write(JSON.stringify(results)); }
`;

/**
 * @param {string} path
 * @param {number} uid
 * @param {number} gid
 * @param {number} mode
 */
async function assertMetadata(path, uid, gid, mode) {
  const metadata = await stat(path);
  const actualMode = metadata.mode & 0o777;
  if (metadata.uid !== uid || metadata.gid !== gid || actualMode !== mode) {
    throw new Error(
      `invalid fixture metadata for ${path}: expected ${uid}:${gid} ${mode.toString(8)}, got ${metadata.uid}:${metadata.gid} ${actualMode.toString(8)}`,
    );
  }
}

try {
  // `mkdtemp` is 0700/root by default. Open only traverse on this test harness
  // parent so denial is proven at the production runtime/turn boundary below.
  await chmod(root, 0o711);
  await mkdir(turn, { recursive: true });
  await chown(runtime, AGENT_UID, RUNTIME_GID);
  await chmod(runtime, 0o170);
  for (const directory of [turns, turn]) {
    await chown(directory, RUNNER_UID, RUNTIME_GID);
    await chmod(directory, 0o770);
  }
  await writeFile(eventFile, originalEvent);
  await writeFile(journalFile, originalJournal);
  for (const file of [eventFile, journalFile]) {
    await chown(file, RUNNER_UID, RUNTIME_GID);
    await chmod(file, 0o660);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(controlSocket, resolve);
  });
  listening = true;
  await chown(controlSocket, RUNNER_UID, RUNTIME_GID);
  await chmod(controlSocket, 0o660);

  await assertMetadata(runtime, AGENT_UID, RUNTIME_GID, 0o170);
  await assertMetadata(turns, RUNNER_UID, RUNTIME_GID, 0o770);
  await assertMetadata(turn, RUNNER_UID, RUNTIME_GID, 0o770);
  await assertMetadata(eventFile, RUNNER_UID, RUNTIME_GID, 0o660);
  await assertMetadata(journalFile, RUNNER_UID, RUNTIME_GID, 0o660);
  await assertMetadata(controlSocket, RUNNER_UID, RUNTIME_GID, 0o660);

  const child = spawn(
    '/usr/bin/setpriv',
    [
      `--reuid=${AGENT_UID}`,
      `--regid=${AGENT_GID}`,
      '--clear-groups',
      '--no-new-privs',
      '--inh-caps=-all',
      '--ambient-caps=-all',
      '--bounding-set=-all',
      process.execPath,
      '-e',
      childScript,
    ],
    {
      env: {
        FORGERY_TURNS: turns,
        FORGERY_EVENT: eventFile,
        FORGERY_JOURNAL: journalFile,
        FORGERY_CREATED: join(turn, 'forged.jsonl'),
        FORGERY_SOCKET: controlSocket,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  /** @type {number | null} */
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  if (exitCode !== 0) throw new Error(`forgery child failed (${exitCode}): ${stderr}`);
  const parsed = /** @type {unknown} */ (JSON.parse(stdout));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('forgery child returned an invalid result');
  }
  const results = /** @type {Record<string, unknown>} */ (parsed);
  const expected = {
    uid: AGENT_UID,
    gid: AGENT_GID,
    capInh: '0000000000000000',
    capPrm: '0000000000000000',
    capEff: '0000000000000000',
    capBnd: '0000000000000000',
    capAmb: '0000000000000000',
    noNewPrivs: '1',
    listTurns: 'EACCES',
    appendEvent: 'EACCES',
    appendJournal: 'EACCES',
    createTurnFile: 'EACCES',
    connectControl: 'EACCES',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (results[key] !== value) {
      throw new Error(
        `forgery boundary mismatch for ${key}: expected ${value}, got ${String(results[key])}`,
      );
    }
  }
  if (
    !Array.isArray(results.groups) ||
    !results.groups.every((group) => typeof group === 'number')
  ) {
    throw new Error('forgery child returned invalid supplementary groups');
  }
  if (results.groups.includes(RUNTIME_GID)) {
    throw new Error('agent child retained the Runner runtime group');
  }
  if ((await readFile(eventFile, 'utf8')) !== originalEvent) {
    throw new Error('agent child forged the event stream');
  }
  if ((await readFile(journalFile, 'utf8')) !== originalJournal) {
    throw new Error('agent child forged the control journal');
  }
  if (connections !== 0) throw new Error('agent child connected to the Runner control socket');
  process.stdout.write('runner forgery boundary rejected all attacks\n');
} finally {
  if (listening) await new Promise((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
