import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'install.sh');
const workspaces = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true });
});

function executable(path, body) {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function host({ architecture = 'x86_64', installTools = false, uid = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-bootstrap-'));
  workspaces.push(root);

  executable(join(root, 'id'), `printf '%s\\n' ${uid}`);
  executable(
    join(root, 'uname'),
    `if [[ \${1-} == -s ]]; then printf '%s\\n' Linux; else printf '%s\\n' ${architecture}; fi`,
  );
  executable(join(root, 'readlink'), `printf '%s\\n' /opt`);
  executable(
    join(root, 'stat'),
    `if [[ $* == *%u* ]]; then printf '%s\\n' 0; else printf '%s\\n' 755; fi`,
  );
  executable(
    join(root, 'docker'),
    `if [[ $* == *--format* ]]; then printf '%s\\n' 25.0.0; fi`,
  );
  for (const tool of ['awk', 'grep', 'mktemp']) executable(join(root, tool), ':');
  if (!installTools) {
    for (const tool of ['tar', 'flock', 'openssl']) executable(join(root, tool), ':');
  } else {
    executable(
      join(root, 'apt-get'),
      `if [[ \${1-} == install ]]; then
         printf '%s\\n' '#!/bin/bash' ':' >"$VERITY_TEST_BIN/tar"
         printf '%s\\n' '#!/bin/bash' ':' >"$VERITY_TEST_BIN/flock"
         printf '%s\\n' '#!/bin/bash' ':' >"$VERITY_TEST_BIN/openssl"
         /usr/bin/chmod 0755 "$VERITY_TEST_BIN/tar" "$VERITY_TEST_BIN/flock" "$VERITY_TEST_BIN/openssl"
       fi`,
    );
  }
  return root;
}

function run(bin, ...args) {
  return spawnSync('/bin/bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: bin, VERITY_TEST_BIN: bin },
  });
}

test('preflight reports every detected problem before exiting', () => {
  const bin = host({ architecture: 'aarch64' });
  rmSync(join(bin, 'docker'));
  rmSync(join(bin, 'tar'));
  rmSync(join(bin, 'flock'));

  const result = run(bin, '--preflight');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /preflight failed \(4 issues\)/);
  assert.match(result.stderr, /amd64\/x86_64 is required \(found aarch64\)/);
  assert.match(result.stderr, /tar is required/);
  assert.match(result.stderr, /flock is required/);
  assert.match(result.stderr, /Docker 25 or newer is required/);
  assert.match(result.stderr, /--install-missing/);
});

test('successful preflight exits before pulling an image', () => {
  const result = run(host(), '--preflight');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed/);
});

test('install-missing installs basic tools and repeats the preflight', () => {
  const result = run(host({ installTools: true }), '--preflight', '--install-missing');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /installing missing system tools: tar flock openssl/);
  assert.match(result.stdout, /preflight passed/);
});

test('install-missing preserves the aggregated report without root or sudo', () => {
  const result = run(host({ installTools: true, uid: 1000 }), '--preflight', '--install-missing');

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /installing missing system tools/);
  assert.match(result.stderr, /preflight failed \(4 issues\)/);
  assert.match(result.stderr, /tar is required/);
  assert.match(result.stderr, /flock is required/);
  assert.match(result.stderr, /openssl is required/);
  assert.match(result.stderr, /root access is required/);
});
