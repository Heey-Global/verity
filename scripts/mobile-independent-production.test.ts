import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Workflow = {
  jobs: Record<
    string,
    {
      if?: string;
      steps: { name?: string; run?: string; uses?: string; with?: Record<string, string> }[];
    }
  >;
};
const production = parse(
  readFileSync('.github/workflows/mobile-production-build.yml', 'utf8'),
) as Workflow;
const builder = parse(
  readFileSync('.github/workflows/mobile-native-build.yml', 'utf8'),
) as Workflow;
const wait = production.jobs['finalize-mobile-production']!.steps.find(
  (step) => step.name === 'Wait for verified staging publication',
)!.run!;
const resolve = builder.jobs.build!.steps.find(
  (step) => step.name === 'Resolve immutable native release source',
)!.run!;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verity-independent-native-'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'native-candidates'));
  const executable = (name: string, body: string) => {
    const path = join(root, 'bin', name);
    writeFileSync(path, '#!/usr/bin/env bash\nset -euo pipefail\n' + body);
    chmodSync(path, 0o755);
  };
  executable(
    'gh',
    `
if [[ "$1 $2" == 'release view' ]]; then cat "$RUNNER_TEMP/release.json";
elif [[ "$1 $2" == 'release download' ]]; then cp "$RUNNER_TEMP/staging.json" "$RUNNER_TEMP/native-staging.json";
else exit 22; fi
`,
  );
  // No real sleeps: bound the wait without allowing a draft to pass the gate.
  executable('git', "printf '%040d' 0\n");
  executable('sleep', 'exit 0\n');
  executable('seq', "printf '1\\n2\\n'\n");
  return {
    root,
    run: (script: string) =>
      spawnSync('bash', ['-c', script], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
          RUNNER_TEMP: root,
          MOBILE_TAG: 'mobile-v1.54.0',
          VERITY_APP_VARIANT: 'production',
          GITHUB_OUTPUT: join(root, 'output'),
        },
      }),
  };
}

describe('independent native production', () => {
  it.each([true, false])(
    'resolves the same immutable source before and after staging publication (draft=%s)',
    (draft) => {
      const f = fixture();
      try {
        const source = 'a'.repeat(40);
        writeFileSync(
          join(f.root, 'release.json'),
          JSON.stringify({ isDraft: draft, targetCommitish: source }),
        );
        const result = f.run(resolve);
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(join(f.root, 'output'), 'utf8')).toBe(`sha=${source}\n`);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    'valid',
    'draft',
    'missing-evidence',
    'different-source',
    'different-version',
    'same-app',
  ])('requires published staging evidence matching the production candidate (%s)', (scenario) => {
    const f = fixture();
    try {
      writeFileSync(
        join(f.root, 'release.json'),
        JSON.stringify({
          isDraft: scenario === 'draft',
          assets: scenario === 'missing-evidence' ? [] : [{ name: 'native-staging.json' }],
        }),
      );
      const staging = {
        product: 'mobile-native',
        source: 'a'.repeat(40),
        version: '1.54.0',
        appId: 'staging-app',
      };
      writeFileSync(join(f.root, 'staging.json'), JSON.stringify(staging));
      writeFileSync(
        join(f.root, 'native-candidates/native-production.json'),
        JSON.stringify({
          ...staging,
          appId: scenario === 'same-app' ? staging.appId : 'production-app',
          source: scenario === 'different-source' ? 'b'.repeat(40) : staging.source,
          version: scenario === 'different-version' ? '1.55.0' : staging.version,
        }),
      );
      const result = f.run(wait);
      expect(result.status, result.stderr).not.toBeNull();
      expect(result.status === 0, result.stderr).toBe(scenario === 'valid');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

// Background production must exit before Apple's upload command even when signing succeeds.
it('stores production evidence and stops before uploading to Apple', () => {
  const step = builder.jobs.build!.steps.find(
    (step) => step.name === 'Build native release and upload staging only',
  )!.run!;
  const start = step.indexOf('if [[ "$VERITY_APP_VARIANT" == production ]]');
  const end = step.indexOf('mkdir -p "$HOME/.appstoreconnect/private_keys"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(step.indexOf('--upload-app')).toBeGreaterThan(end);
  expect(step).not.toContain('--auto-submit');
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'Verity.ipa'), 'prepared archive');
    const result = f.run(`ipa="$RUNNER_TEMP/Verity.ipa"
ASC_APP_ID=123
next_build=42
${step.slice(start, end)}
exit 99`);
    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(join(f.root, 'native-production.json'), 'utf8'));
    expect(evidence.schema).toBe(2);
    expect(evidence.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// Recovery must not re-enter the native builder or accept an unrelated workflow's output.
it('recovers the existing production run with no binary rebuild', () => {
  const workflow = parse(
    readFileSync('.github/workflows/mobile-production-build.yml', 'utf8'),
  ) as Workflow;
  expect(workflow.jobs['publish-mobile-native']!.if).toBe("inputs.production-run-id == ''");
  const finalizer = workflow.jobs['finalize-mobile-production']!;
  expect(finalizer.if).toContain("needs.publish-mobile-native.result == 'skipped'");
  const download = finalizer.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  expect(download!.with!['run-id']).toBe('${{ inputs.production-run-id || github.run_id }}');
  const check = finalizer.steps.find(
    (step: { name?: string }) => step.name === 'Verify recovery build provenance',
  )!.run!;
  const root = mkdtempSync(join(tmpdir(), 'verity-recovery-run-'));
  try {
    mkdirSync(join(root, 'bin'));
    const gh = join(root, 'bin/gh');
    writeFileSync(
      gh,
      `#!/usr/bin/env bash
set -euo pipefail
jq -r "$4" "$RUNNER_TEMP/run.json"
`,
    );
    chmodSync(gh, 0o755);
    const valid = {
      path: '.github/workflows/mobile-production-build.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
    };
    for (const run of [
      valid,
      { ...valid, path: 'another.yml' },
      { ...valid, event: 'pull_request' },
      { ...valid, head_branch: 'unreviewed' },
    ]) {
      writeFileSync(join(root, 'run.json'), JSON.stringify(run));
      const result = spawnSync('bash', ['-c', check], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${root}/bin:${process.env.PATH}`,
          RUNNER_TEMP: root,
          GH_REPO: 'example/repo',
          PRODUCTION_RUN_ID: '123',
        },
      });
      expect(result.status, result.stderr).toBe(run === valid ? 0 : 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
