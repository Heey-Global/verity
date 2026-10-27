import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('./verify-evidence.mjs', import.meta.url));
// Synthetic evidence tests the verifier, never the runtime's isolation.
for (const missing of [
  null,
  'feature-marker.txt',
  'runtime/bundles/feature',
  'runtime/bundles/dockerfile',
  'runtime/runsc/debug.log',
]) {
  test(`evidence is ${missing ? `rejected without ${missing}` : 'accepted when complete'}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'devcontainer-evidence-'));
    try {
      mkdirSync(join(root, 'runtime/bundles'), { recursive: true });
      mkdirSync(join(root, 'runtime/runsc'), { recursive: true });
      const files = {
        'dockerfile-marker.txt': 'dockerfile-run\n',
        'feature-marker.txt': 'feature-install\n',
        'runsc-version.txt': 'runsc version release-test\n',
        'runtime/invocations.log': '--root /state run --bundle /bundle id\n',
        'runtime/bundles/dockerfile': JSON.stringify({
          process: { args: ['/bin/sh', '-c', "printf 'verity-probe: dockerfile-run'"] },
        }),
        'runtime/bundles/feature': JSON.stringify({
          process: { args: ['/bin/sh', '-c', './devcontainer-features-install.sh'] },
        }),
        'runtime/runsc/debug.log': 'synthetic runtime log\n',
      };
      for (const [path, content] of Object.entries(files)) {
        if (path !== missing) writeFileSync(join(root, path), content);
      }
      const result = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
      assert.equal(result.status === 0, missing === null, result.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
