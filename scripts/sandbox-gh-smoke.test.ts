import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
}

describe('sandbox image GitHub wrapper smoke', () => {
  it.each(['agent-seed/bin/gh', 'features/verity-sandbox-toolkit/agent-seed/bin/gh'])(
    'executes the workflow probe with %s',
    (wrapper) => {
      const workflow = parse(
        readFileSync('.github/workflows/verity-sandbox.yml', 'utf8'),
      ) as Workflow;
      const run = workflow.jobs['architecture-smoke']?.steps.find(
        (step) => step.name === 'Smoke-test image',
      )?.run;
      expect(run).toBeDefined();
      const start = run!.indexOf('tmp_gh_test="$(mktemp -d)"');
      const end = run!.indexOf('test -x /usr/local/bin/verity-code-review', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // Image-only wrapper probes otherwise drift outside the local test suite.
      const probe = run!.slice(start, end).replaceAll('/usr/local/bin/gh', '"$SMOKE_GH_WRAPPER"');
      expect(() =>
        execFileSync('bash', ['-euo', 'pipefail', '-c', probe], {
          env: {
            ...process.env,
            VERITY_FORGE_MODE: '',
            VERITY_FORGE_PROXY_URL: '',
            VERITY_FORGE_PROXY_CA_FILE: '',
            SMOKE_GH_WRAPPER: resolve(wrapper),
          },
          timeout: 10_000,
          stdio: 'pipe',
        }),
      ).not.toThrow();
    },
  );
});
