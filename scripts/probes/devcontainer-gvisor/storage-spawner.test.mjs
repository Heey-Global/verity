import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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

const compiled = new URL('../../../packages/server/dist/build-storage.js', import.meta.url);
// The host-service job builds the Server first. Container-only probes install
// only the devcontainer CLI and cannot run the Server integration fixture.
test(
  'Server CI spawner records cold/warm phases and releases successful attempts and retains uncertain remote failures',
  { skip: !existsSync(compiled) },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'storage-spawner-'));
    try {
      writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
      const bin = join(root, 'bin');
      const evidence = join(root, 'evidence');
      mkdirSync(bin);
      mkdirSync(evidence);
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      writeFileSync(
        join(bin, 'devcontainer'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const output = args[args.indexOf('--output') + 1];
if (!output.startsWith('type=docker,dest=')) process.exit(2);
fs.writeFileSync(output.slice('type=docker,dest='.length), 'owned archive');
console.log('fixture build');
`,
        { mode: 0o755 },
      );
      const report = join(root, 'storage.json');
      const observedAt = new Date().toISOString();
      writeFileSync(
        report,
        JSON.stringify({
          schemaVersion: 1,
          hostBootId: '11111111-1111-4111-8111-111111111111',
          hostIdentity: 'a'.repeat(64),
          observedAt,
          roots: ['buildkit', 'docker', 'containerd', 'export', 'project'].map((kind) => ({
            kind,
            state: 'available',
            observedAt,
            filesystemId: 'fixture',
            availableBytes: 100 * 1024 ** 3,
            freeInodes: 1_000_000,
          })),
        }),
      );
      for (const warm of ['0', '1']) {
        const result = spawnSync(
          process.execPath,
          [new URL('./server-spawner.mjs', import.meta.url).pathname, root, 'fixture:storage'],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              PROBE_STORAGE_ROOT: join(root, 'owned'),
              PROBE_STORAGE_REPORT: report,
              PROBE_EVIDENCE: evidence,
              PROBE_WARM: warm,
              VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT: 'unix:///fixture/buildkit.sock',
            },
            encoding: 'utf8',
            timeout: 15_000,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(readdirSync(join(root, 'owned')), []);
      }
      const records = readdirSync(evidence);
      assert.equal(records.length, 2);
      assert(records.some((file) => file.includes('-cold-')));
      assert(records.some((file) => file.includes('-warm-')));
      for (const file of records) {
        const { samples } = JSON.parse(readFileSync(join(evidence, file), 'utf8'));
        assert(samples.some((sample) => sample.phase === 'build/export'));
        assert(samples.some((sample) => sample.phase === 'import'));
        assert(samples.every((sample) => sample.localAvailableBytes > 0));
      }
      writeFileSync(
        join(bin, 'devcontainer'),
        `#!/usr/bin/env node
process.stderr.write('runsc-real unavailable\\n' + 'CLI stack detail\\n'.repeat(400));
process.exit(1);
`,
        { mode: 0o755 },
      );
      const failure = spawnSync(
        process.execPath,
        [new URL('./server-spawner.mjs', import.meta.url).pathname, root, 'fixture:failure'],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            PROBE_STORAGE_ROOT: join(root, 'owned'),
            PROBE_STORAGE_REPORT: report,
            PROBE_EVIDENCE: evidence,
            VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT: 'unix:///fixture/buildkit.sock',
          },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      assert.equal(failure.status, 1);
      assert.match(failure.stderr, /runsc-real unavailable/);
      assert.match(failure.stderr, /Devcontainer build\/export failed/);
      const retained = readdirSync(join(root, 'owned'));
      assert.equal(retained.length, 1);
      assert.equal(
        JSON.parse(readFileSync(join(root, 'owned', retained[0], 'remote-operation.json'), 'utf8'))
          .operation,
        'build-export',
      );
      const crashRoot = join(root, 'crash-owned');
      writeFileSync(
        join(bin, 'devcontainer'),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const record = path.join(path.dirname(process.env.DOCKER_CONFIG), 'remote-operation.json');
if (!fs.existsSync(record)) process.exit(9);
fs.writeFileSync(path.join(process.env.DOCKER_CONFIG, 'image.tar'), 'possibly remotely owned');
process.kill(process.ppid, 'SIGKILL');
process.exit(1);
`,
        { mode: 0o755 },
      );
      const restartEnv = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PROBE_STORAGE_ROOT: crashRoot,
        PROBE_STORAGE_REPORT: report,
        VERITY_DEVCONTAINER_BUILDKIT_ENDPOINT: 'unix:///fixture/buildkit.sock',
      };
      const invoke = () =>
        spawnSync(
          process.execPath,
          [new URL('./server-spawner.mjs', import.meta.url).pathname, root, 'fixture:crash'],
          { env: restartEnv, encoding: 'utf8', timeout: 15000 },
        );
      const crashed = invoke();
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
      const attempts = readdirSync(crashRoot);
      assert.equal(attempts.length, 1);
      const attempt = join(crashRoot, attempts[0]);
      assert(existsSync(join(attempt, 'remote-operation.json')));
      const restarted = invoke();
      assert.equal(restarted.status, 1, restarted.stderr);
      assert.match(restarted.stderr, /termination is unconfirmed/);
      assert(existsSync(join(attempt, 'remote-operation.json')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('real Engine cancellation probe uses production remote tracking and a separate reservation root', () => {
  const cancellation = readFileSync(
    new URL('./storage-import-cancel.mjs', import.meta.url),
    'utf8',
  );
  const host = readFileSync(new URL('./host-service.sh', import.meta.url), 'utf8');
  assert.match(cancellation, /signal: abort.signal,\s+remoteOperation: 'image-import'/);
  assert.match(cancellation, /assert.equal\(lease.retainArtifacts, true\)/);
  assert.match(
    cancellation,
    /assert.throws\(\(\) => storage.acquire\(\), \/termination is unconfirmed\//,
  );
  assert.match(host, /PROBE_STORAGE_ROOT_OVERRIDE="\$work\/import-cancel-build-storage" run_probe/);
});
