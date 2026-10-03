import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(process.env.STAGING_WORKFLOW ?? '.github/workflows/release.yml', 'utf8'),
) as {
  jobs: Record<
    string,
    { steps: { name?: string; run?: string; uses?: string; with?: Record<string, unknown> }[] }
  >;
};
const run = workflow.jobs['finalize-backend-release']!.steps.find(
  (step) => step.name === 'Open production approval for staged Server',
)!.run!;
const labels = run.indexOf('labels="$(gh api');
if (labels < 0) throw new Error('Staging label transition is missing');
const script = run.slice(labels, run.indexOf('gh workflow run release-dispatch.yml', labels));

function fixture(initial: string) {
  const root = mkdtempSync(join(tmpdir(), 'verity-stage-labels-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'labels'), initial);
  const gh = join(root, 'bin/gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STAGE_TEST_ROOT/calls"
if [[ "$1" == api && "$2" != --method ]]; then cat "$STAGE_TEST_ROOT/labels";
elif [[ "$1 $2 $3" == 'api --method POST' ]]; then printf 'autorelease: tagged\\n' >> "$STAGE_TEST_ROOT/labels";
elif [[ "$1 $2 $3" == 'api --method DELETE' ]]; then
 grep -Fxq 'autorelease: pending' "$STAGE_TEST_ROOT/labels" || exit 22
 sed '/autorelease: pending/d' "$STAGE_TEST_ROOT/labels" > "$STAGE_TEST_ROOT/next"
 mv "$STAGE_TEST_ROOT/next" "$STAGE_TEST_ROOT/labels"
elif [[ "$1 $2" == 'release edit' ]]; then [[ "\${STAGE_FAIL_PUBLISH:-0}" != 1 ]];
else exit 23; fi
`,
  );
  chmodSync(gh, 0o755);
  return {
    root,
    run: (fail = false) =>
      spawnSync('bash', ['-c', `set -euo pipefail\npr=42\n${script}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          STAGE_TEST_ROOT: root,
          STAGE_FAIL_PUBLISH: fail ? '1' : '0',
          GITHUB_REPOSITORY: 'example/repo',
          TAG: 'v2.0.0',
        },
      }),
  };
}
describe('Staging finalization retries', () => {
  it('records native evidence and approval before clearing the draft-only retry boundary', () => {
    const steps = workflow.jobs['finalize-mobile-staging']!.steps;
    const approval = steps.findIndex((step) => step.name === 'Open native production approval');
    const publication = steps.findIndex(
      (step) => step.name === 'Publish verified native GitHub release',
    );
    expect(approval).toBeGreaterThanOrEqual(0);
    expect(publication).toBeGreaterThan(approval);
    expect(steps[approval]?.run).toContain('gh release upload');
    expect(steps[approval]?.run).toContain('production-promotion.ts propose');
    expect(publication).toBe(steps.length - 1);
  });
  it.each(['finalize-mobile-staging', 'finalize-backend-release'])(
    'fetches promotion branch merge bases in %s',
    (job) => {
      const checkout = workflow.jobs[job]!.steps.find((step) =>
        step.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout?.with?.['fetch-depth']).toBe(0);
    },
  );
  it.each([
    'autorelease: pending\n',
    'autorelease: pending\nautorelease: tagged\n',
    'autorelease: tagged\n',
  ])('finishes from label state %j', (initial) => {
    const f = fixture(initial);
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.root, 'labels'), 'utf8')).toBe('autorelease: tagged\n');
      if (!initial.includes('pending'))
        expect(readFileSync(join(f.root, 'calls'), 'utf8')).not.toContain('DELETE');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it('recovers when publication failed after removing the pending label', () => {
    const f = fixture('autorelease: pending\n');
    try {
      expect(f.run(true).status).not.toBe(0);
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.root, 'calls'), 'utf8').match(/DELETE/g)).toHaveLength(1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
