import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../deploy/buildkit/runsc-netns.sh', import.meta.url));

// runsc strips the addresses of the namespace it starts in, and BuildKit hands
// that namespace to the next step. Without the restore, only the first RUN step
// after a builder start reaches the network; every later one sees loopback only.
function fixture({ runtimeStatus = 0, withNetns = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'runsc-netns-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'calls.log');
  const netns = join(root, 'netns');
  writeFileSync(netns, '');
  writeFileSync(
    join(bin, 'nsenter'),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
shift
case "$*" in
  "ip -4 -o addr show scope global") printf '%s\\n' '2: eth1    inet 10.213.0.3/24 brd 10.213.0.255 scope global eth1' ;;
  "ip -4 route show default") printf '%s\\n' 'default via 10.213.0.1 dev eth1' ;;
esac
`,
  );
  chmodSync(join(bin, 'nsenter'), 0o755);
  const runtime = join(root, 'runtime');
  writeFileSync(
    runtime,
    `#!/bin/sh\nprintf 'runtime %s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${runtimeStatus}\n`,
  );
  chmodSync(runtime, 0o755);
  const bundle = join(root, 'bundle path');
  mkdirSync(bundle);
  writeFileSync(
    join(bundle, 'config.json'),
    JSON.stringify({
      linux: {
        namespaces: [
          { type: 'pid' },
          withNetns ? { type: 'network', path: netns } : { type: 'network' },
        ],
      },
    }),
  );
  const run = (args) =>
    spawnSync('sh', [script, runtime, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return {
    root,
    netns,
    bundle,
    run,
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
  };
}

test('restores the step interface after runsc exits, keeping its status', () => {
  for (const runtimeStatus of [0, 3]) {
    const f = fixture({ runtimeStatus });
    try {
      const result = f.run(['--debug', 'run', '--bundle', f.bundle, 'id']);
      assert.equal(result.status, runtimeStatus, result.stderr);
      const calls = f.calls();
      const runtimeAt = calls.findIndex((call) => call.startsWith('runtime '));
      assert.equal(calls[runtimeAt], `runtime --debug run --bundle ${f.bundle} id`);
      assert.deepEqual(calls.slice(runtimeAt + 1), [
        `--net=${f.netns} ip link set dev eth1 up`,
        `--net=${f.netns} ip addr replace 10.213.0.3/24 dev eth1`,
        `--net=${f.netns} ip route replace default via 10.213.0.1 dev eth1`,
      ]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test('accepts --bundle=<dir> as well', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['run', `--bundle=${f.bundle}`, 'id']).status, 0);
    assert(f.calls().some((call) => call.includes('ip addr replace 10.213.0.3/24 dev eth1')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('passes other commands and host-network steps straight through', () => {
  for (const [args, options] of [
    [['delete', '--force', 'id'], {}],
    [['run', '--bundle', null, 'id'], { withNetns: false }],
  ]) {
    const f = fixture(options);
    try {
      const resolved = args.map((arg) => arg ?? f.bundle);
      assert.equal(f.run(resolved).status, 0);
      assert.deepEqual(f.calls(), [`runtime ${resolved.join(' ')}`]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});
