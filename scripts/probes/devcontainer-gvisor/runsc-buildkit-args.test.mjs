import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const adapter = fileURLToPath(new URL('./runsc-buildkit-args.sh', import.meta.url));
for (const { args, expected } of [
  {
    args: [
      '--log',
      '/log path',
      '--log-format',
      'json',
      'run',
      '--bundle',
      '/bundle path',
      '--keep',
      'id',
    ],
    expected: [
      '--log',
      '/log path',
      '--log-format',
      'json',
      'run',
      '--bundle',
      '/bundle path',
      'id',
    ],
  },
  {
    args: ['--debug', 'delete', '--force', 'id'],
    expected: ['--debug', 'delete', '--force', 'id'],
  },
  { args: ['--version'], expected: ['--version'] },
  { args: ['run', '--keep=false', 'id'], expected: ['run', '--keep=false', 'id'] },
]) {
  test(`adapts ${JSON.stringify(args)}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'runsc-args-'));
    try {
      const runtime = join(root, 'fake-runtime');
      writeFileSync(
        runtime,
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
      );
      chmodSync(runtime, 0o755);
      const result = spawnSync('sh', [adapter, runtime, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('propagates an unavailable runtime failure', () => {
  const result = spawnSync('sh', [
    adapter,
    '/nonexistent-runsc-probe-runtime',
    'run',
    '--keep',
    'id',
  ]);
  assert.equal(result.status, 127);
});
