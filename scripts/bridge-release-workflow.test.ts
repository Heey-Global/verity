import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; if?: string };
type Job = { if?: string; steps?: Step[]; with?: Record<string, string> };
const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
  on: { workflow_call: { inputs: Record<string, unknown> } };
  jobs: Record<string, Job>;
};
const dispatch = parse(readFileSync('.github/workflows/release-dispatch.yml', 'utf8')) as {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, Job>;
};
const step = (job: string, name: string) => {
  const found = release.jobs[job]?.steps?.find((entry) => entry.name === name);
  expect(found, `${job}: ${name} moved; re-derive this guard`).toBeDefined();
  return found!;
};

describe('artifact-only maintenance release', () => {
  it('requires explicit dispatch opt-in scoped to the backend train', () => {
    for (const inputs of [release.on.workflow_call.inputs, dispatch.on.workflow_dispatch.inputs]) {
      expect(inputs['backend-artifact-only']).toMatchObject({ type: 'boolean', default: false });
    }
    expect(dispatch.jobs['release-train']?.with?.['backend-artifact-only']).toBe(
      "${{ matrix.train == 'backend' && inputs['backend-artifact-only'] || false }}",
    );
  });

  it('rejects incomplete or unsafe bridge publication before any writes', () => {
    const validation = step('release-please', 'Validate artifact-only maintenance request');
    expect(release.jobs['release-please']?.steps?.[0]).toBe(validation);
    const valid = {
      ARTIFACT_ONLY: 'true',
      EVENT_NAME: 'workflow_dispatch',
      TRAIN: 'backend',
      VERSION: '0.15.2',
      SOURCE_REF: 'fix/schema-bridge',
      SCHEMA_FORWARD_MAX: '0098_google_workspace_files',
      REPUBLISH: 'false',
      ACCEPT_NO_ROLLBACK: 'false',
    };
    const run = (overrides: Record<string, string>) =>
      spawnSync('bash', ['-c', validation.run!], {
        env: { ...process.env, ...valid, ...overrides },
        encoding: 'utf8',
      });
    expect(run({}).status).toBe(0);
    for (const overrides of [
      { EVENT_NAME: 'push' },
      { TRAIN: 'mobile' },
      { VERSION: '' },
      { SOURCE_REF: '' },
      { SCHEMA_FORWARD_MAX: '' },
      { SCHEMA_FORWARD_MAX: 'invalid' },
      { REPUBLISH: 'true' },
      { ACCEPT_NO_ROLLBACK: 'true' },
    ])
      expect(run(overrides).status).toBe(1);
    expect(run({ ARTIFACT_ONLY: 'false', SCHEMA_FORWARD_MAX: '' }).status).toBe(0);
  });

  it('publishes immutable indexes without moving mutable image aliases', () => {
    // Execute the checked-in publishers: merely asserting an input exists misses
    // a sibling publisher silently moving latest back to the maintenance version.
    const publishers = Object.values(release.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((entry) => entry.run?.includes('publish-release-index.mjs'));
    expect(publishers.length).toBeGreaterThan(0);
    const directory = mkdtempSync(join(tmpdir(), 'bridge-release-'));
    try {
      for (const publisher of publishers) {
        for (const artifactOnly of [true, false]) {
          const script = publisher
            .run!.replaceAll('${{ inputs.backend-artifact-only }}', String(artifactOnly))
            .replace(/\$\{\{[^}]+\}\}/gu, 'fixture');
          const result = spawnSync(
            'bash',
            [
              '-c',
              `
            git() { echo 0123456789ab; }
            node() { echo IMMUTABLE_INDEX; }
            docker() {
              if [[ "$*" == *"imagetools create"* ]]; then echo "PROMOTION $*";
              else printf 'sha256:%064d\\n' 0; fi
            }
            ${script}
          `,
            ],
            {
              env: {
                ...process.env,
                REGISTRY: 'registry',
                IMAGE_NAME: 'image',
                IMAGE_NAME_NEW: 'new-image',
                VERSION: '0.15.2',
                SOURCE_REVISION: '0123456789abcdef',
                GITHUB_OUTPUT: join(directory, 'output'),
              },
              encoding: 'utf8',
            },
          );
          expect(result.status, `${publisher.name}: ${result.stderr}`).toBe(0);
          expect(result.stdout).toContain('IMMUTABLE_INDEX');
          if (artifactOnly) expect(result.stdout).not.toContain('PROMOTION');
          else expect(result.stdout).toContain(':latest');
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('suppresses toolkit aliases and channels but allows finalization with complete evidence', () => {
    for (const name of ['Publish verity-sandbox-toolkit', 'Publish toolkit channel tags']) {
      expect(step('publish-toolkit', name).if).toBe("${{ !inputs['backend-artifact-only'] }}");
    }
    expect(release.jobs['publish-server-channels']?.if).toContain(
      "!inputs['backend-artifact-only']",
    );
    const finalize = release.jobs['finalize-backend-release']?.if;
    expect(finalize).toContain('always()');
    expect(finalize).toContain(
      "inputs['backend-artifact-only'] && needs.publish-server-channels.result == 'skipped'",
    );
    expect(finalize).toContain("needs.publish-server-release-evidence.result == 'success'");
    const publish = step('finalize-backend-release', 'Publish verified backend release').run;
    expect(publish).toContain('[ "${{ inputs.backend-artifact-only }}" != true ]');
    expect(publish).toContain('gh release edit "$TAG" --draft=false --latest=false');
    const evidence = step(
      'publish-server-release-evidence',
      'Attach verified Sigstore evidence to the GitHub release',
    ).run;
    expect(evidence).toContain('.release-envelope.json');
    expect(evidence).toContain('"$envelope" --clobber');
  });
});
