/**
 * Trusted CLI socket operands — the half CI cannot construct.
 *
 * The argv integrity rule requires every operand to live at a root-owned,
 * unwritable path. A Unix socket is admitted by node type but still held to that
 * ownership, and its OWN write bits are waived, because write permission on a
 * socket is what connect(2) checks: a socket the trusted CLI can reach at all is
 * necessarily group- or other-writable.
 *
 * That waiver is the security-relevant part of the change, and no unprivileged
 * test process can exercise it — every directory this process may write into
 * fails the ownership rule by definition, so the accepting cases are unreachable
 * from Vitest. The refusals are real tests
 * (`packages/server/src/trusted-cli-argv.test.ts`,
 * `packages/server/src/runner-supervisor-feature.test.ts`); this measures the
 * rest, so the claim does not rest on an argument nobody re-ran.
 *
 * Root-owned nodes without root: a user namespace maps this uid to 0, and a
 * tmpfs mounted inside it is owned by that mapped root. Nothing outside the
 * namespace is touched — the mount is private to the child and gone when it
 * exits.
 *
 * Run:
 *
 * ```sh
 * node scripts/probes/trusted-cli-socket-operand.mjs
 * ```
 *
 * `unshare: Operation not permitted` means the kernel withholds unprivileged
 * user namespaces (Ubuntu 24.04 restricts them through AppArmor by default).
 * Then run it as root instead, where only the mount namespace is still needed —
 * keep the `-m`, or the tmpfs replaces the real /tmp for every process on the
 * host and stays there after the probe exits:
 *
 * ```sh
 * sudo unshare -m sh -c 'mount -t tmpfs -o mode=0755 tmpfs /tmp &&
 *   exec node scripts/probes/trusted-cli-socket-operand.mjs --inner /tmp'
 * ```
 */
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

const brokerUrl = new URL(
  '../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs',
  import.meta.url,
);

const inner = process.argv.indexOf('--inner');
if (inner < 0) {
  // Mounted over /tmp, and not a directory inside it: the ownership walk covers
  // every ancestor, and the real /tmp belongs to a uid this namespace leaves
  // unmapped, so it would fail as `nobody` before any operand is reached. The
  // tmpfs replaces that node itself, and only for this child.
  const target = '/tmp';
  const result = spawnSync(
    'unshare',
    [
      '-Urm',
      'sh',
      '-c',
      `mount -t tmpfs -o mode=0755 tmpfs "$1" && exec node "$0" --inner "$1"`,
      process.argv[1],
      target,
    ],
    { stdio: 'inherit' },
  );
  if (result.error) {
    console.error(`could not enter a user namespace: ${result.error.message}`);
    process.exit(2);
  }
  process.exit(result.status ?? 2);
}

const rootDir = process.argv[inner + 1];
if (typeof rootDir !== 'string' || !rootDir.startsWith('/')) {
  console.error('usage: trusted-cli-socket-operand.mjs --inner <absolute dir>');
  process.exit(2);
}

// Before writing anything: a target that is not the expected tmpfs means the
// mount did not happen, and the probe would refuse every case for that reason
// alone while looking like a real result.
const target = await lstat(rootDir);
if (target.uid !== 0 || (target.mode & 0o022) !== 0) {
  console.error(
    `${rootDir} is uid ${target.uid} mode ${(target.mode & 0o7777).toString(8)}; expected the ` +
      'root-owned tmpfs this probe mounts — run it without --inner',
  );
  process.exit(2);
}

const { validateTrustedCliArguments } = await import(brokerUrl.href);

/** Bind a socket and give it the mode a non-root client needs to connect(2). */
async function listen(path) {
  const server = createServer();
  await new Promise((listening) => server.listen(path, listening));
  await chmod(path, 0o666);
  return server;
}

// `mkdir` inherits the umask, so every mode this probe depends on is set
// explicitly afterwards — a directory that came out 0755 instead of 0777 would
// turn a refusal case into a pass for the wrong reason.
const daemonDir = join(rootDir, 'run/tailscale');
await mkdir(daemonDir, { recursive: true });
await chmod(daemonDir, 0o755);
const looseDir = join(rootDir, 'loose');
await mkdir(looseDir, { recursive: true });
await chmod(looseDir, 0o777);
// The effective PATH is validated too, and the real /usr/bin belongs to a uid
// this namespace does not map, so the probe supplies its own.
const binDir = join(rootDir, 'bin');
await mkdir(binDir, { recursive: true });
await chmod(binDir, 0o755);

const socket = join(daemonDir, 'tailscaled.sock');
const loose = join(looseDir, 'ts.sock');
const servers = [await listen(socket), await listen(loose)];
const link = join(daemonDir, 'link.sock');
await symlink(loose, link);
const data = join(daemonDir, 'filter.jq');
await writeFile(data, '.\n');
await chmod(data, 0o666);

for (const path of [rootDir, daemonDir, socket, looseDir, loose, data]) {
  const entry = await lstat(path);
  console.log(`  ${path} uid=${entry.uid} mode=${(entry.mode & 0o7777).toString(8)}`);
}

const cases = [
  // What the rule now admits: a daemon endpoint at a root-owned path, writable
  // by everyone because connect(2) demands it.
  ['accept', 'root-owned socket', '/usr/bin/tailscale', [`--socket=${socket}`, 'status']],
  ['accept', 'same socket, two tokens', '/usr/bin/tailscale', ['--socket', socket, 'status']],
  // The waiver covers the socket's own bits and nothing above it: the directory
  // still decides who may unlink the node and bind a different peer in its place.
  ['refuse', 'socket in a writable directory', '/usr/bin/tailscale', [`--socket=${loose}`]],
  // And nothing reaches it by a spelling whose ancestors happen to be immutable.
  ['refuse', 'symlink into a writable directory', '/usr/bin/tailscale', [`--socket=${link}`]],
  // An interpreter reads its operand for bytes, so a special file there is
  // refused for being one however it is owned.
  ['refuse', 'socket as an interpreter script', '/bin/sh', [socket]],
  // The waiver is about sockets, not about write bits: a regular file anyone may
  // rewrite is exactly what the rule exists to refuse.
  ['refuse', 'world-writable regular file', '/usr/bin/jq', ['-f', data]],
];

let failures = 0;
for (const [expected, label, command, args] of cases) {
  let outcome = 'accept';
  let detail = '';
  try {
    await validateTrustedCliArguments(command, args, daemonDir, binDir);
  } catch (error) {
    outcome = 'refuse';
    detail = ` (${error instanceof Error ? error.message : String(error)})`;
  }
  const ok = outcome === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} expected ${expected}, got ${outcome}: ${label}${detail}`);
}

for (const server of servers) server.close();
console.log(failures === 0 ? 'all cases as expected' : `${failures} case(s) deviated`);
process.exit(failures === 0 ? 0 : 1);
