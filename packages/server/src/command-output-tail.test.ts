import { describe, expect, it } from 'vitest';
import { commandOutputTail } from './provisioner.js';

// Shape of a real failed `devcontainer build` stderr: BuildKit's own error,
// then the CLI's one-line echo of the whole `docker buildx build` command and
// its Node stack. Before the frames were dropped, the surfaced message was
// only the end of that echo plus `devContainersSpecCLI.js` frames.
const buildArgs = Array.from(
  { length: 40 },
  (_, i) => `--build-arg _DEV_CONTAINERS_ARG_${i}=value-${i}`,
).join(' ');
const failedBuild = [
  '#12 [dev_container_auto_added_stage_label 9/31] RUN case "$TARGETARCH" in',
  '#12 0.512 curl: (22) The requested URL returned error: 404',
  '#12 ERROR: process "/bin/sh -c case \\"$TARGETARCH\\" in" did not complete successfully: exit code: 22',
  'ERROR: failed to solve: process "/bin/sh -c case" did not complete successfully: exit code: 22',
  `Error: Command failed: docker buildx build --load ${buildArgs} /tmp/verity-build-yn3vQM`,
  '    at IW (/usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js:470:2009)',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)',
  '    at async Sp (/usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js:469:1910)',
  '    at async f9 (/usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js:671:2524)',
  '    at async h9 (/usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js:670:5791)',
  '    at async /usr/local/lib/node_modules/@devcontainers/cli/dist/spec-node/devContainersSpecCLI.js:488:1917',
].join('\n');

describe('commandOutputTail', () => {
  it('keeps the BuildKit failure that a devcontainer CLI stack trace would bury', () => {
    const tail = commandOutputTail(failedBuild);
    expect(tail).toContain('curl: (22) The requested URL returned error: 404');
    expect(tail).toContain('ERROR: failed to solve');
    expect(tail).not.toContain('devContainersSpecCLI.js');
  });

  it('caps a single overlong line instead of letting it consume the budget', () => {
    const tail = commandOutputTail(failedBuild);
    const echo = tail.split('\n').find((line) => line.startsWith('Error: Command failed:'));
    expect(echo).toBeDefined();
    expect(echo!.length).toBeLessThan(300);
    expect(echo).toMatch(/\/tmp\/verity-build-yn3vQM$/);
  });

  it('keeps indented output that is not a stack frame', () => {
    expect(commandOutputTail('step failed\n    at least one package is missing')).toBe(
      'step failed\n    at least one package is missing',
    );
  });
});
