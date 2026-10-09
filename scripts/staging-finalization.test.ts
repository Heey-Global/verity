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
    {
      env?: Record<string, string>;
      steps: {
        name?: string;
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
      }[];
    }
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
elif [[ "$1 $2" == 'release view' ]]; then
 if [[ "\${STAGE_PRODUCTION_DONE:-0}" == 1 ]]; then printf '{"isDraft":false,"isPrerelease":false}\\n';
 else printf '{"isDraft":false,"isPrerelease":true}\\n'; fi
elif [[ "$1 $2" == 'release edit' ]]; then [[ "\${STAGE_FAIL_PUBLISH:-0}" != 1 ]];
else exit 23; fi
`,
  );
  chmodSync(gh, 0o755);
  return {
    root,
    run: (fail = false, production = false, override = script) =>
      spawnSync('bash', ['-c', `set -euo pipefail\npr=42\n${override}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          STAGE_TEST_ROOT: root,
          STAGE_FAIL_PUBLISH: fail ? '1' : '0',
          STAGE_PRODUCTION_DONE: production ? '1' : '0',
          MOBILE_TAG: 'mobile-v2.0.0',
          GITHUB_REPOSITORY: 'example/repo',
          TAG: 'v2.0.0',
        },
      }),
  };
}
describe('Staging finalization retries', () => {
  it('preserves an already promoted Server release on staging recovery', () => {
    const f = fixture('autorelease: tagged\n');
    try {
      const result = f.run(false, true);
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(f.root, 'calls'), 'utf8')).not.toContain('release edit');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    'preserves mobile production status on recovery (production=%s)',
    (production) => {
      const publish = workflow.jobs['finalize-mobile-staging']!.steps.find(
        (step) => step.name === 'Publish verified native GitHub release',
      )!.run!;
      const helper = publish.slice(
        publish.indexOf('publish_staging_release() {'),
        publish.indexOf('# Artifact-only'),
      );
      const f = fixture('autorelease: tagged\n');
      try {
        const result = f.run(false, production, helper + '\npublish_staging_release');
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(f.root, 'calls'), 'utf8').includes('release edit')).toBe(
          !production,
        );
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
  it('pins Server approval to the revision actually attested by the release workflow', () => {
    const prepare = workflow.jobs['prepare-server-channels']!;
    const approval = workflow.jobs['finalize-backend-release']!.steps.find(
      (step) => step.name === 'Open production approval for staged Server',
    )!;
    expect(approval.env?.SOURCE).toBe(prepare.env?.REVISION);
    expect(
      prepare.steps.find((step) => step.name === 'Prepare signed architecture release channel')
        ?.run,
    ).toContain('VERITY_RELEASE_REVISION="$REVISION"');
  });
  // Separate artifact folders leave attestations present but make publication's flat paths fail.
  it('merges Server evidence archives into the folder consumed by publication', () => {
    const job = Object.values(workflow.jobs).find((job) =>
      job.steps?.some(
        (step) => step.name === 'Attach verified Sigstore evidence to the GitHub release',
      ),
    )!;
    const download = job.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))!;
    const publication = job.steps.find(
      (step) => step.name === 'Attach verified Sigstore evidence to the GitHub release',
    )!.run!;
    expect(download.with?.['merge-multiple']).toBe(true);
    const paths = [
      ...publication.matchAll(/(?:payload|bundle|provenance|envelope)="([^"]+)"/g),
    ].map((match) => match[1]!);
    expect(paths.length).toBeGreaterThan(0);
    const folder = download.with?.path;
    expect(folder).toBeTypeOf('string');
    expect(paths.every((path) => path.startsWith(`${folder as string}/`))).toBe(true);
  });
  it('publishes staging with only its own verified evidence', () => {
    const steps = workflow.jobs['finalize-mobile-staging']!.steps;
    const evidence = steps.findIndex((step) => step.name === 'Record verified staging build');
    const publication = steps.findIndex(
      (step) => step.name === 'Publish verified native GitHub release',
    );
    expect(evidence).toBeGreaterThanOrEqual(0);
    expect(publication).toBeGreaterThan(evidence);
    expect(steps[evidence]?.run).toContain('native-staging.json');
    expect(steps[evidence]?.run).not.toContain('native-production.json');
    expect(
      steps
        .slice(publication + 1)
        .every((step) => step.run?.includes('gh workflow run mobile-ota.yml')),
    ).toBe(true);
  });
  it('delegates archive reuse and expiry replacement to the production proposer', () => {
    const production = parse(
      readFileSync('.github/workflows/mobile-production-build.yml', 'utf8'),
    ) as typeof workflow;
    const approval = production.jobs['finalize-mobile-production']!.steps.find(
      (step) => step.name === 'Open native production approval',
    )!.run!;
    expect(approval).toContain('node scripts/production-promotion.ts propose');
    expect(approval).toContain('native-candidates/native-production.json');
    expect(approval).not.toContain('gh release download');
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

it('resumes skipped OTA planning after successful native Staging publication', () => {
  const steps = workflow.jobs['finalize-mobile-staging']!.steps;
  const published = steps.findIndex(
    (step) => step.name === 'Publish verified native GitHub release',
  );
  const resume = steps.findIndex((step) =>
    step.run?.includes('gh workflow run mobile-ota.yml --ref main'),
  );
  expect(published).toBeGreaterThan(-1);
  expect(resume).toBeGreaterThan(published);
  expect(steps[resume]?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
});
