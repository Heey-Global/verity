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
  'Server CI spawner records cold/warm phases and releases every owned attempt',
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
