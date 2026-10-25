import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

for (const adapterPath of [
  './runsc-buildkit-args.sh',
  '../../../deploy/buildkit/runsc-buildkit-args.sh',
]) {
  const adapter = fileURLToPath(new URL(adapterPath, import.meta.url));
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

  test('worker wrapper preserves build writes and records the OCI bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'runsc-wrapper-'));
    try {
      const runtime = join(root, 'runtime');
      writeFileSync(
        runtime,
        `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
      );
      chmodSync(runtime, 0o755);
      const helper = join(root, 'adapter');
      writeFileSync(helper, readFileSync(adapter));
      chmodSync(helper, 0o755);
      const evidence = join(root, 'evidence');
      const bundle = join(root, 'bundle');
      mkdirSync(join(evidence, 'bundles'), { recursive: true });
      mkdirSync(bundle);
      const spec = JSON.stringify({ process: { args: ['/bin/sh', '-c', 'echo probe'] } });
      writeFileSync(join(bundle, 'config.json'), spec);
      const source = readFileSync(new URL('./runsc-probe.sh', import.meta.url), 'utf8')
        .replaceAll('/usr/local/bin/runsc-buildkit-args', helper)
        .replaceAll('/usr/local/bin/runsc-real', runtime)
        .replaceAll('/evidence', evidence);
      const wrapper = join(root, 'wrapper');
      writeFileSync(wrapper, source);
      const result = spawnSync('sh', [wrapper, 'run', '--bundle', bundle, '--keep', 'id'], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const args = JSON.parse(result.stdout);
      assert(args.includes('--overlay2=none'), 'Writes must reach the BuildKit snapshot');
      assert(args.includes('--platform=systrap'));
      assert(args.includes('--network=sandbox'));
      assert(!args.includes('--keep'));
      assert.match(readFileSync(join(evidence, 'invocations.log'), 'utf8'), /run --bundle/);
      const records = readdirSync(join(evidence, 'bundles'));
      assert.equal(records.length, 1);
      assert.equal(readFileSync(join(evidence, 'bundles', records[0]), 'utf8'), spec);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
