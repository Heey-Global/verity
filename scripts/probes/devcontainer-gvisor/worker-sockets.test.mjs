import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
const source = readFileSync(new URL('./verify-worker-sockets.mjs', import.meta.url), 'utf8');
const check = (path) =>
  spawnSync(process.execPath, ['--input-type=module', '-', path], {
    input: source,
    encoding: 'utf8',
  });
test('accepts an unavailable socket but rejects a listening host socket', async () => {
  const root = mkdtempSync('/tmp/verity-sock-');
  const path = join(root, 'host.sock');
  const server = createServer((socket) => socket.destroy());
  try {
    const absent = check(path);
    assert.equal(absent.status, 0, absent.stderr);
    await new Promise((resolve) => server.listen(path, resolve));
    const result = check(path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Host control socket is reachable/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts an existing socket inode with no listener, as used by systemd masks', () => {
  const root = mkdtempSync('/tmp/verity-sock-');
  const path = join(root, 'masked.sock');
  try {
    const bound = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { createServer } from 'node:net'; createServer().listen(process.argv[1], () => process.exit(0));",
        path,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(bound.status, 0, bound.stderr);
    const result = check(path);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
