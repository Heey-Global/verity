import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
assert(root, 'Usage: node verify-evidence.mjs <evidence-directory>');
assert.equal(readFileSync(join(root, 'dockerfile-marker.txt'), 'utf8').trim(), 'dockerfile-run');
assert.equal(readFileSync(join(root, 'feature-marker.txt'), 'utf8').trim(), 'feature-install');
assert.match(readFileSync(join(root, 'runsc-version.txt'), 'utf8'), /^runsc version release-/);

const bundles = readdirSync(join(root, 'runtime/bundles')).map((file) => {
  /** @type {{ process?: { args?: string[] } }} */
  const bundle = JSON.parse(readFileSync(join(root, 'runtime/bundles', file), 'utf8'));
  assert(Array.isArray(bundle.process?.args), 'Missing OCI process arguments');
  return bundle.process.args.join(' ');
});
assert(
  bundles.some((command) => command.includes('verity-probe: dockerfile-run')),
  'No worker-side OCI bundle for the Dockerfile RUN',
);
assert(
  bundles.some((command) => command.includes('devcontainer-features-install.sh')),
  'No worker-side OCI bundle for Feature installation',
);
assert.match(readFileSync(join(root, 'runtime/invocations.log'), 'utf8'), /\b(run|create)\b/);
const logs = join(root, 'runtime/runsc');
assert(
  readdirSync(logs).some(
    (file) => statSync(join(logs, file)).isFile() && statSync(join(logs, file)).size > 0,
  ),
  'No runsc debug evidence',
);
console.log('Positive probe evidence complete; unavailable-worker tests must pass separately.');
