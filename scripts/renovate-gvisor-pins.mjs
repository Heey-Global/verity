#!/usr/bin/env node
// Derives every gVisor pin on a Renovate branch that bumped RUNSC_RELEASE; see
// renovate-gvisor.yml. Renovate rewrites only the release name. The checksums the hosts verify,
// the label the Updater reads and the path the Server verifies follow from it through
// gvisor-pins.mjs, and are committed here through renovate-branch.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { CONFIG_FILE, LABEL_FILE, PIN_FILE, readPins } from './gvisor-pins.mjs';
import { branchArguments, commitToBranch } from './renovate-branch.mjs';

const { repository, branch, headSha } = branchArguments(
  process.argv.slice(2),
  'renovate-gvisor-pins.mjs',
);

execFileSync(process.execPath, ['scripts/gvisor-pins.mjs', 'write'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/gvisor-pins.mjs', 'check'], { stdio: 'inherit' });

const changed = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' })
  .split('\n')
  .filter((path) => path !== '');
if (changed.length === 0) {
  console.log('Every gVisor pin already matches the release this branch names; nothing to commit.');
  process.exit(0);
}
const derived = new Set([PIN_FILE, LABEL_FILE, CONFIG_FILE]);
const unexpected = changed.filter((path) => !derived.has(path));
if (unexpected.length !== 0)
  throw new Error(`gvisor-pins.mjs changed files it does not own: ${unexpected.join(', ')}`);

const release = readPins(readFileSync(PIN_FILE, 'utf8')).RUNSC_RELEASE;
commitToBranch({
  repository,
  branch,
  headSha,
  message: `chore(deps): derive the gVisor pins for ${release}`,
  paths: changed,
});
