import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const hasTools = ['python3', 'jq', 'flock', 'timeout', 'sync'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

it.skipIf(!hasTools)(
  'executes the production egress wrapper against a direct-only host manager fixture',
  async () => {
    const { stderr } = await promisify(execFile)(
      'python3',
      ['scripts/probes/project-egress/test_provision_wrapper.py'],
      { timeout: 60_000 },
    );
    expect(stderr).toContain('OK');
  },
  65_000,
);
