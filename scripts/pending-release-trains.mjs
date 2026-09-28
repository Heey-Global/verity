#!/usr/bin/env node
// Selects, on top of the trains a push chose from its diff, every train whose
// merged release PR is still unpublished. The release lifecycle then decides
// per train whether that publication belongs to this run.
import { appendFileSync } from 'node:fs';
import { pendingReleasePrs } from './pending-release-prs.mjs';

const trains = /** @type {const} */ ([
  ['backend', 'server'],
  ['mobile', 'mobile'],
  ['website', 'website'],
]);
const outputFile = process.env.GITHUB_OUTPUT;
if (!outputFile) throw new Error('GITHUB_OUTPUT is required');

for (const [train, component] of trains) {
  const diffSelected = process.env[`DIFF_${train.toUpperCase()}`] === 'true';
  let selected = diffSelected;
  if (!selected) {
    const pending = pendingReleasePrs(component);
    if (pending.length) {
      const numbers = pending.map((pr) => `#${pr.number}`).join(', ');
      console.log(
        `::notice::${train}: release PR ${numbers} is merged and unpublished; selecting the train so this run reconciles it.`,
      );
      selected = true;
    }
  }
  appendFileSync(outputFile, `${train}=${selected}\n`);
}
