import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
}

interface ReleaseWorkflow {
  jobs: {
    'build-project-relay': {
      needs?: string | string[];
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'build-sandbox': {
      needs?: string | string[];
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'build-server': {
      needs?: string[];
      if?: string;
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'prepare-server-build-context': {
      needs?: string | string[];
      steps: WorkflowStep[];
    };
    'build-preview-images': {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'publish-project-relay': {
      needs?: string | string[];
      outputs?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'publish-toolkit': {
      needs?: string | string[];
      steps: WorkflowStep[];
    };
    'publish-sandbox': {
      needs?: string | string[];
      steps: WorkflowStep[];
    };
    'publish-server': {
      outputs?: Record<string, string>;
      needs?: string[];
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'prepare-server-channels': ReleaseWorkflow['jobs']['publish-server-channels'];
    'publish-server-channels': {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      env?: Record<string, string>;
      needs?: string[];
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'publish-server-release-evidence': {
      env?: Record<string, string>;
      needs?: string[];
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'publish-preview-images': {
      needs?: string[];
      steps: WorkflowStep[];
    };
    'finalize-backend-release': {
      needs?: string[];
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    };
  };
}

describe('release relay digest output', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;
  const steps = workflow.jobs['publish-project-relay'].steps;

  it('captures and validates the pushed OCI digest', () => {
    const build = workflow.jobs['build-project-relay'];
    expect(build.strategy?.matrix?.include).toEqual([
      { architecture: 'amd64', runner: 'ubuntu-24.04' },
      { architecture: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    const push = build.steps.find((step) => step.name?.startsWith('Build + push'));
    expect(push?.uses).toContain('docker/build-push-action@');
    expect(push?.with?.platforms).toBe('linux/${{ matrix.architecture }}');

    const publish = steps.find((step) => step.name === 'Publish multi-architecture relay index');
    expect(publish?.run).toContain('sha-${short_sha}-amd64');
    expect(publish?.run).toContain('sha-${short_sha}-arm64');
    const record = steps.find((step) => step.name === 'Record digest-pinned relay reference');
    expect(record?.run).toContain('^sha256:[a-f0-9]{64}$');
    expect(record?.run).toContain('imagetools inspect');
    expect(record?.run).toContain('verity-project-relay-image.txt');
    expect(record?.run).toContain('Bundled into the matching');
    expect(record?.run).toContain('GITHUB_OUTPUT');
    expect(record?.run).toContain('GITHUB_STEP_SUMMARY');
    expect(workflow.jobs['publish-project-relay'].outputs?.image).toBe(
      '${{ steps.relay-reference.outputs.image }}',
    );
  });

  it('uploads the exact reference as a release artifact', () => {
    const upload = steps.find((step) => step.name === 'Upload digest-pinned relay reference');
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload?.with).toMatchObject({
      name: 'verity-project-relay-image',
      path: 'verity-project-relay-image.txt',
      'if-no-files-found': 'error',
    });
  });

  it('bakes the release-matched relay digest into the Server image', () => {
    const server = workflow.jobs['publish-server'];
    const buildServer = workflow.jobs['build-server'];
    // The relay digest is baked in as a build arg, so that dependency is
    // structural. The sandbox image and toolkit Feature are not baked in, but a
    // released Server resolves BOTH at its OWN version instead of `:latest` —
    // so shipping a Server whose siblings failed to publish would point it at
    // tags that do not exist. `self-update-gate` is the one dependency that is
    // not a sibling artifact: it proves the live cutover (ADR 0008's release
    // condition). It is listed here as well as on the siblings, so reading this
    // job alone still shows the release gate.
    expect(server.needs).toEqual([
      'release-please',
      'self-update-gate',
      'publish-project-relay',
      'publish-sandbox',
      'publish-toolkit',
      'build-server',
    ]);
    // …and every one of them runs under the same condition, so the added
    // dependencies only order jobs that were going to run anyway.
    for (const name of server.needs.slice(1)) {
      expect(workflow.jobs[name]?.if).toBe(server.if);
    }

    const build = buildServer.steps.find((step) => step.name?.startsWith('Build + push'));
    expect(build?.with?.['build-args']).toContain(
      'VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${{ needs.publish-project-relay.outputs.image }}',
    );

    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    expect(dockerfile).toContain('ARG VERITY_BUNDLED_PROJECT_RELAY_IMAGE=');
    expect(dockerfile).toContain(
      'ENV VERITY_BUNDLED_PROJECT_RELAY_IMAGE=${VERITY_BUNDLED_PROJECT_RELAY_IMAGE}',
    );

    const compose = readFileSync('deploy/docker-compose.yml', 'utf8');
    expect(compose).not.toContain('VERITY_PROJECT_RELAY_IMAGE');
  });

  it('labels the Server image with the PostgreSQL pin the compose file carries', () => {
    // ADR 0008 D14. Without this wiring a Renovate bump to the compose pin
    // reaches an installed host exactly once, at bootstrap, and its database is
    // never patched again — which is precisely the state this test exists to
    // stop the release workflow from silently returning to.
    const server = workflow.jobs['build-server'];
    const resolve = server.steps.find((step) => step.name === 'Resolve the bundled PostgreSQL pin');
    expect(resolve?.id).toBe('postgres');
    // Read out of the compose file, so the line Renovate bumps stays the one
    // source of truth and cannot drift from what a fresh install bootstraps.
    expect(resolve?.run).toContain('deploy/docker-compose.yml');

    const build = server.steps.find((step) => step.name?.startsWith('Build + push'));
    expect(build?.with?.['build-args']).toContain(
      'VERITY_BUNDLED_POSTGRES_IMAGE=${{ steps.postgres.outputs.image }}',
    );

    const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
    expect(dockerfile).toContain('ARG VERITY_BUNDLED_POSTGRES_IMAGE=');
    // A LABEL and not an ENV: `managed-server-owner.ts` keeps exactly one
    // image-provided environment exemption, and a second one re-opens the
    // spec/image disagreement that once stopped the Updater starting its Server.
    expect(dockerfile).toContain(
      'LABEL org.verity.postgres-image=${VERITY_BUNDLED_POSTGRES_IMAGE}',
    );
    expect(dockerfile).not.toContain('ENV VERITY_BUNDLED_POSTGRES_IMAGE');

    // The extractor's own contract: exactly one digest-pinned postgres image in
    // the file it reads, or the release fails rather than guessing.
    const compose = readFileSync('deploy/docker-compose.yml', 'utf8');
    const pins = compose.match(/^\s*image:\s*postgres:\S+@sha256:[0-9a-f]{64}\s*$/gm);
    expect(pins).toHaveLength(1);
  });
});

describe('multi-architecture runtime image publication', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;
  const matrix = [
    { architecture: 'amd64', runner: 'ubuntu-24.04' },
    { architecture: 'arm64', runner: 'ubuntu-24.04-arm' },
  ];

  it('builds each architecture natively before assigning shared release tags', () => {
    for (const name of ['build-sandbox', 'build-project-relay'] as const) {
      const job = workflow.jobs[name];
      expect(job.strategy?.matrix?.include).toEqual(matrix);
      const builds = job.steps.filter((step) => step.uses?.startsWith('docker/build-push-action@'));
      expect(builds.length).toBeGreaterThan(0);
      for (const build of builds) {
        expect(build.with?.platforms).toBe('linux/${{ matrix.architecture }}');
      }
    }
  });

  it('merges both architecture artifacts into each public image tag', () => {
    const sandbox = workflow.jobs['publish-sandbox'].steps.find(
      (step) => step.name === 'Publish multi-architecture sandbox indexes',
    );
    expect(sandbox?.run).toContain(
      'for image in "${REGISTRY}/${IMAGE_NAME}" "${REGISTRY}/${IMAGE_NAME_NEW}"',
    );
    expect(sandbox?.run).toContain('publish-release-index.mjs');
    expect(sandbox?.run).toContain('${image}:sha-${short_sha}-amd64');
    expect(sandbox?.run).toContain('${image}:sha-${short_sha}-arm64');

    const relay = workflow.jobs['publish-project-relay'].steps.find(
      (step) => step.name === 'Publish multi-architecture relay index',
    );
    expect(relay?.run).toContain('${image}:sha-${short_sha}-amd64');
    expect(relay?.run).toContain('${image}:sha-${short_sha}-arm64');
  });

  it('prepares local Server inputs while the release gate runs without bypassing it', () => {
    // Waiting for published siblings here silently puts a local-only compiler
    // job on the critical path after every image has already finished.
    const prepare = workflow.jobs['prepare-server-build-context'];
    expect([prepare.needs].flat()).toEqual(['release-please']);
    const build = workflow.jobs['build-server'];
    expect(build.needs).toEqual(
      expect.arrayContaining([
        'prepare-server-build-context',
        'self-update-gate',
        'publish-project-relay',
        'publish-sandbox',
        'publish-toolkit',
      ]),
    );
  });

  it('overlaps candidate builds with acceptance while keeping version publication gated', () => {
    for (const component of ['sandbox', 'project-relay'] as const) {
      expect([workflow.jobs[`build-${component}`].needs].flat()).toEqual(['release-please']);
      expect([workflow.jobs[`publish-${component}`].needs].flat()).toEqual(
        expect.arrayContaining(['self-update-gate', `build-${component}`]),
      );
    }
  });

  it('publishes the toolkit with the exact compiler artifacts consumed by the Server', () => {
    const prepare = workflow.jobs['prepare-server-build-context'];
    const toolkit = workflow.jobs['publish-toolkit'];
    expect([toolkit.needs].flat()).toEqual(
      expect.arrayContaining(['self-update-gate', 'prepare-server-build-context']),
    );
    const serverDownload = workflow.jobs['build-server'].steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    const toolkitDownload = toolkit.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(toolkitDownload).toBeDefined();
    expect(toolkitDownload?.with).toEqual(serverDownload?.with);
    expect(
      prepare.steps.some((step) => step.run === 'scripts/build-script-sandbox-prebuilts.sh'),
    ).toBe(true);
    expect(
      toolkit.steps.some((step) =>
        /build-script-sandbox-prebuilts|update-toolkit-ledger/.test(step.run ?? ''),
      ),
    ).toBe(false);
    const downloadIndex = toolkit.steps.indexOf(toolkitDownload!);
    expect(downloadIndex).toBeLessThan(
      toolkit.steps.findIndex((step) => step.name === 'Stamp release version into manifest'),
    );
  });

  it('builds the Server natively and signs the merged index digest', () => {
    const prepare = workflow.jobs['prepare-server-build-context'];
    const compile = prepare.steps.find(
      (step) => step.name === 'Build attested script sandbox artifacts',
    );
    expect(compile?.run).toBe('scripts/build-script-sandbox-prebuilts.sh');
    const upload = prepare.steps.find(
      (step) => step.name === 'Upload trusted Server build context',
    );
    expect(upload?.with?.path).toContain('prebuilt/linux-amd64/verity-script-sandbox');
    expect(upload?.with?.path).toContain('prebuilt/linux-arm64/verity-script-sandbox');

    const build = workflow.jobs['build-server'];
    expect(build.strategy?.matrix?.include).toEqual(matrix);
    const push = build.steps.find((step) => step.name?.startsWith('Build + push'));
    expect(push?.with?.platforms).toBe('linux/${{ matrix.architecture }}');
    expect(push?.with?.tags).toBe('${{ steps.tags.outputs.tag }}');
    const tag = build.steps.find((step) => step.name === 'Compute architecture tag');
    expect(tag?.run).toContain('sha-${short_sha}-${{ matrix.architecture }}');
    expect(
      build.steps.find((step) => step.name === 'Build attested script sandbox artifacts'),
    ).toBeUndefined();
    const download = build.steps.find(
      (step) => step.name === 'Download trusted Server build context',
    );
    expect(download?.with?.path).toBe('features/verity-sandbox-toolkit');

    const server = workflow.jobs['publish-server'];
    expect(server.needs).toContain('build-server');
    const publish = server.steps.find(
      (step) => step.name === 'Publish multi-architecture Server index',
    );
    expect(publish?.run).toContain('${image}:sha-${short_sha}-amd64');
    expect(publish?.run).toContain('${image}:sha-${short_sha}-arm64');
    expect(publish?.run).toContain('echo "digest=$digest"');
    const attest = server.steps.find((step) => step.name === 'Attest Server image provenance');
    expect(attest?.with?.['subject-digest']).toBe('${{ steps.build.outputs.digest }}');
    const sign = server.steps.find((step) => step.name === 'Sign the Server image');
    expect(sign?.env?.SERVER_DIGEST).toBe('${{ steps.build.outputs.digest }}');
  });

  it('publishes preview indexes only after all native component builds finish', () => {
    const build = workflow.jobs['build-preview-images'];
    expect(build.strategy?.matrix?.include).toHaveLength(4);
    expect(
      build.strategy?.matrix?.include?.map(({ component, architecture }) => ({
        component,
        architecture,
      })),
    ).toEqual([
      { component: 'edge', architecture: 'amd64' },
      { component: 'edge', architecture: 'arm64' },
      { component: 'connector', architecture: 'amd64' },
      { component: 'connector', architecture: 'arm64' },
    ]);
    const push = build.steps.find((step) => step.name === 'Build and publish');
    expect(push?.with?.platforms).toBe('linux/${{ matrix.architecture }}');

    const publish = workflow.jobs['publish-preview-images'];
    expect(publish.needs).toContain('build-preview-images');
    const index = publish.steps.find(
      (step) => step.name === 'Publish multi-architecture preview index',
    );
    expect(index?.run).toContain('${image}:sha-${short_sha}-amd64');
    expect(index?.run).toContain('${image}:sha-${short_sha}-arm64');
  });

  it('keeps every host entry point aligned with the published Server architectures', () => {
    const published = new Set(
      workflow.jobs['build-server'].strategy?.matrix?.include?.map(({ architecture }) =>
        String(architecture),
      ),
    );
    const nodeSource = readFileSync('packages/server/src/server-main.ts', 'utf8');
    const nodeArchitectures = new Set(
      [...nodeSource.matchAll(/^\s+case '[^']+':\n\s+return '([^']+)';$/gmu)].map(
        ([, architecture]) => architecture,
      ),
    );
    const shellArchitectures = (path: string) => {
      const source = readFileSync(path, 'utf8');
      return new Set(
        [
          ...source.matchAll(
            /^\s+[^)]*\) (?:host_architecture|VERITY_HOST_ARCHITECTURE)=([^ ;]+) ;;$/gmu,
          ),
        ].map(([, architecture]) => architecture),
      );
    };

    expect(nodeArchitectures).toEqual(published);
    expect(shellArchitectures('deploy/bin/verity-install')).toEqual(published);
    expect(shellArchitectures('docs/website/site/install.sh')).toEqual(published);
    expect(shellArchitectures('deploy/bin/verity-compose')).toEqual(published);
    expect(readFileSync('deploy/bin/verity-compose', 'utf8')).toContain(
      `${[...published].join('|')}) ;;`,
    );
  });
});

describe('release merge policy', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    jobs: { 'release-please': { steps: WorkflowStep[] } };
  };

  it('requires squash-only history before Release Please', () => {
    const steps = workflow.jobs['release-please'].steps;
    const guardIndex = steps.findIndex((step) => step.name === 'Enforce release-safe merge policy');
    const guard = steps[guardIndex];
    const firstReleasePleaseIndex = steps.findIndex((step) =>
      step.uses?.startsWith('googleapis/release-please-action@'),
    );
    expect(guard?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(guard?.run).toContain(
      '[.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge] | @tsv',
    );
    expect(guard?.run).toContain("!= $'false\\ttrue\\tfalse'");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(firstReleasePleaseIndex).toBeGreaterThan(guardIndex);
  });

  it('keeps an empty push diff from failing train selection', () => {
    const steps = workflow.jobs['release-please'].steps;
    const selectIndex = steps.findIndex(
      (step) => step.name === 'Select release trains for this push',
    );
    expect(selectIndex).toBeGreaterThan(-1);
    const select = steps[selectIndex];
    // The break this guards: a squash merge whose content already landed on
    // main pushes an empty tree diff. Failing there paints every duplicate
    // merge red and skips the delayed-release catch-up that runs after
    // selection, so the selector must fall through to the default trains.
    expect(select?.run).toContain('Could not resolve the immutable push diff');
    expect(select?.run).not.toContain('refusing to select a train');
    expect(select?.run).toContain('::notice::Empty push diff');
    expect(select?.run).toContain('selecting the default trains');
  });

  it.each([
    { version: '1.2.3', source: true, succeeds: true },
    { version: '1.2.4', source: true, succeeds: false },
    { version: '1.2.4', source: false, succeeds: true },
  ])(
    'distinguishes package migration from release publication ($version, source=$source)',
    ({ version, source, succeeds }) => {
      const root = mkdtempSync(join(tmpdir(), 'verity-release-migration-'));
      const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      try {
        git('init', '--quiet');
        git('config', 'user.email', 'test@example.invalid');
        git('config', 'user.name', 'Release Test');
        git('config', 'commit.gpgsign', 'false');
        const manifest = join(root, ['.release-please-manifest', 'backend', 'json'].join('.'));
        writeFileSync(manifest, JSON.stringify({ '.release/backend': '1.2.3' }));
        git('add', '.');
        git('commit', '--quiet', '-m', 'chore: initial');
        const before = git('rev-parse', 'HEAD');
        writeFileSync(manifest, JSON.stringify({ '.': version }));
        if (source) writeFileSync(join(root, 'product.ts'), 'export const migrated = true;');
        git('add', '.');
        git('commit', '--quiet', '-m', 'fix: migrate release routing');
        const output = join(root, 'output');
        const script = workflow.jobs['release-please'].steps.find(
          (step) => step.name === 'Select release trains for this push',
        )!.run!;
        // A key-only migration used to enter the publication branch and reject
        // its own source changes, leaving every release train broken after merge.
        const result = spawnSync('bash', ['-c', script], {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            BEFORE: before,
            HEAD_SHA: git('rev-parse', 'HEAD'),
            TRAIN: 'backend',
            GITHUB_OUTPUT: output,
          },
        });
        expect(result.status === 0, result.stderr).toBe(succeeds);
        if (succeeds) {
          expect(readFileSync(output, 'utf8')).toContain('backend=true');
          expect(readFileSync(output, 'utf8')).toContain(`website=${source}`);
        } else {
          expect(result.stderr).toContain('does not belong to the release train');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('requires a manual tag only for delayed commits whose workflow tree changed', () => {
    const steps = workflow.jobs['release-please'].steps;
    const pretagIndex = steps.findIndex(
      (step) => step.name === 'Require tags for delayed release commits',
    );
    const pretag = steps[pretagIndex];
    const firstReleasePleaseIndex = steps.findIndex((step) =>
      step.uses?.startsWith('googleapis/release-please-action@'),
    );

    expect(pretagIndex).toBeGreaterThan(-1);
    expect(pretagIndex).toBeLessThan(firstReleasePleaseIndex);
    expect(pretag?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(pretag?.run).toContain("--label 'autorelease: pending'");
    expect(pretag?.run).toContain('git merge-base --is-ancestor');
    expect(pretag?.run).toContain('[[ "$release_sha" != "$HEAD_SHA" ]] || return 0');
    expect(pretag?.run).toContain(
      'git diff --quiet "$release_sha" "$HEAD_SHA" -- .github/workflows && return 0',
    );
    expect(pretag?.run).toContain('git show-ref --verify --quiet "refs/tags/${tag}"');
    expect(pretag?.run).toContain('[[ "$tagged_sha" != "$release_sha" ]]');
    expect(pretag?.run).not.toContain('git push origin "refs/tags/${tag}"');
    expect(pretag?.run).toContain('the workflow token cannot create a tag');
    expect(pretag?.run).toContain('git tag $tag $release_sha');
    expect(pretag?.run).toContain('git push origin refs/tags/$tag');
    expect(pretag?.run).toContain("'.' v");
    expect(pretag?.run).toContain("'apps/mobile' mobile-v");
    expect(pretag?.run).toContain("'docs/website' website-v");
  });
});

describe('website release recovery', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    on: { workflow_call?: { inputs?: Record<string, { type?: string }> } };
    jobs: {
      'release-please': {
        outputs?: Record<string, string>;
        steps: WorkflowStep[];
      };
      'publish-website': {
        if?: string;
        env?: Record<string, string>;
        permissions?: Record<string, string>;
        steps: WorkflowStep[];
      };
    };
  };

  it('accepts an explicit version and source ref only for manual recovery', () => {
    expect(workflow.on.workflow_call?.inputs?.['website-version']?.type).toBe('string');
    expect(workflow.on.workflow_call?.inputs?.['website-ref']?.type).toBe('string');
    const step = workflow.jobs['release-please'].steps.find(
      (candidate) => candidate.id === 'website-recovery',
    );
    expect(step?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(step?.if).toContain("inputs['website-version'] != ''");
    expect(step?.run).toContain('website-ref is required with website-version');
  });

  it('requires an existing release bound to the requested source', () => {
    const step = workflow.jobs['release-please'].steps.find(
      (candidate) => candidate.id === 'website-recovery',
    );
    expect(step?.run).toContain('gh release view "$tag" --json isDraft');
    expect(step?.run).toContain('targetCommitish');
    expect(step?.run).toContain('commits/${tag}');
    expect(step?.run).toContain('if [[ "$source_sha" != "$release_sha" ]]');
  });

  it('feeds the verified recovery outputs into the ordinary website publisher', () => {
    const outputs = workflow.jobs['release-please'].outputs ?? {};
    expect(outputs['website-release-created']).toContain(
      'steps.website-recovery.outputs.release_created',
    );
    expect(outputs['website-version']).toContain('steps.website-recovery.outputs.version');
    expect(outputs['website-sha']).toContain('steps.website-recovery.outputs.sha');
    expect(workflow.jobs['publish-website'].if).toBe(
      "needs.release-please.outputs.website-release-created == 'true'",
    );
    expect(workflow.jobs['publish-website'].env?.VERSION).toBe(
      '${{ needs.release-please.outputs.website-version }}',
    );
  });

  it('keeps automatic website releases as drafts until the image is verified', () => {
    const config = JSON.parse(readFileSync('release-please-config.website.json', 'utf8')) as {
      packages: Record<string, { draft?: boolean }>;
    };
    expect(config.packages['docs/website']?.draft).toBe(true);

    const website = workflow.jobs['publish-website'];
    expect(website.permissions?.contents).toBe('write');
    const publish = website.steps.find((step) => step.name === 'Publish verified website release');
    expect(publish?.run).toContain('--json isDraft');
    expect(publish?.run).toContain('--draft=false');
    const promoteIndex = website.steps.findIndex((step) => step.name === 'Promote tested digest');
    const publishIndex = website.steps.indexOf(publish as WorkflowStep);
    expect(publishIndex).toBeGreaterThan(promoteIndex);
  });
});

describe('signed GitHub release evidence', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;
  const server = workflow.jobs['publish-server'];
  const channels = workflow.jobs['prepare-server-channels'];
  const promotion = workflow.jobs['publish-server-channels'];
  const evidence = workflow.jobs['publish-server-release-evidence'];

  it('passes the verified channel payload to a narrow release writer', () => {
    const upload = channels.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload?.with?.path).toContain('server-release-evidence-${{ matrix.architecture }}/*');

    expect(evidence.needs).toEqual(['release-please', 'prepare-server-channels']);
    expect(evidence.permissions).toEqual({ actions: 'read', contents: 'write' });
    expect(evidence.env?.GH_REPO).toBe('${{ github.repository }}');
    const download = evidence.steps.find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/);
    const publish = evidence.steps.find(
      (step) => step.name === 'Attach verified Sigstore evidence to the GitHub release',
    );
    expect(publish?.run).toContain('jq -e');
    expect(publish?.run).toContain('gh release upload');
    expect(publish?.run).toContain('for architecture in amd64 arm64');
    expect(publish?.run).toContain('.release-channel.sigstore.json');
    expect(publish?.run).toContain('.intoto.jsonl');
  });

  it('creates signed provenance for the immutable Server image digest', () => {
    expect(server.permissions).toMatchObject({
      'artifact-metadata': 'write',
      attestations: 'write',
      'id-token': 'write',
      packages: 'write',
    });
    const attest = server.steps.find((step) => step.uses?.startsWith('actions/attest@'));
    expect(attest?.uses).toMatch(/^actions\/attest@[a-f0-9]{40}$/);
    expect(attest?.with).toMatchObject({
      'subject-digest': '${{ steps.build.outputs.digest }}',
      'push-to-registry': true,
    });
    const channel = channels.steps.find(
      (step) => step.name === 'Prepare signed architecture release channel',
    );
    expect(channel?.run).toContain('cosign verify-attestation');
    expect(channel?.run).toContain('predicate_type=https://slsa.dev/provenance/v1');
    expect(channel?.run).toContain('--type "$predicate_type"');
    expect(channel?.run).toContain('--predicate-type "$predicate_type"');
    expect(channel?.run).not.toContain('--type slsaprovenance');
  });

  it('publishes and records a native channel for every Server architecture', () => {
    expect(channels.strategy?.matrix?.include).toEqual([
      { architecture: 'amd64', runner: 'ubuntu-24.04' },
      { architecture: 'arm64', runner: 'ubuntu-24.04-arm' },
    ]);
    expect(channels.env?.SERVER_DIGEST).toBe('${{ needs.publish-server.outputs.digest }}');
    expect(server.outputs?.digest).toBe('${{ steps.build.outputs.digest }}');
    const publish = channels.steps.find(
      (step) => step.name === 'Prepare signed architecture release channel',
    );
    expect(publish?.run).toContain('imagetools inspect --raw');
    expect(publish?.run).toContain('.platform.architecture == $architecture');
    expect(publish?.run).toContain('--platform "linux/${ARCHITECTURE}"');
    expect(publish?.run).toContain('VERITY_RELEASE_ARCHITECTURE="$ARCHITECTURE"');
    expect(promotion.steps.map((step) => step.run ?? '').join('\n')).toContain(
      'channel-stable-${architecture}',
    );
    expect(publish?.run).toContain('.${ARCHITECTURE}.release-channel.json');
    const promoteRun = promotion.steps.map((step) => step.run ?? '').join('\n');
    expect(promoteRun).toContain('channel.json:application/json');
    expect(promoteRun).not.toContain('"$workdir/channel.json":application/json');
  });

  it('does not advance the stable channel before all release evidence is ready', () => {
    // A green image build alone must not expose a release whose sibling images
    // or published evidence are still missing.
    expect(promotion.needs).toContain('publish-server-release-evidence');
    expect(promotion.needs).toContain('publish-preview-images');
    expect(workflow.jobs['finalize-backend-release'].needs).toContain('publish-server-channels');
    expect(channels.steps.map((step) => step.run ?? '').join('\n')).not.toContain(
      'channel-stable-',
    );
  });

  it('keeps the release mutable until its evidence and artifacts are complete', () => {
    const backend = JSON.parse(readFileSync('release-please-config.backend.json', 'utf8')) as {
      packages: Record<string, { draft?: boolean }>;
    };
    expect(Object.values(backend.packages)[0]?.draft).toBe(true);

    const finalize = workflow.jobs['finalize-backend-release'];
    expect(finalize.env?.GH_REPO).toBe('${{ github.repository }}');
    expect(finalize.needs).toContain('publish-server-release-evidence');
    expect(finalize.permissions?.issues).toBe('write');
    expect(finalize.permissions?.['pull-requests']).toBe('read');
    const publish = finalize.steps.find((step) => step.name === 'Publish verified backend release');
    expect(publish?.run).toContain('--json isDraft');
    expect(publish?.run).toContain('--draft=false');
    expect(publish?.run).toContain('chore(main): release server');
    expect(publish?.run).toContain('labels[]=autorelease: tagged');
    expect(publish?.run).toContain('labels/autorelease%3A%20pending');
    expect(publish?.run).toContain('labels[]=autorelease: pending');
    expect(publish?.run).toContain('labels/autorelease%3A%20tagged');
    expect(publish?.run).toContain('Both labels means an earlier attempt stopped');
    expect(publish?.run).toContain('Leave tagged-only in place');
    expect(publish?.run).toContain('Release PR has neither pending nor tagged label');
    expect(publish?.run?.indexOf('labels[]=autorelease: tagged')).toBeLessThan(
      publish?.run?.indexOf('gh release edit') ?? -1,
    );
  });

  it.each([
    {
      name: 'artifact-only bridge without a release PR',
      artifactOnly: true,
      labels: '',
      expectedStatus: 0,
      expected: '',
    },
    {
      name: 'pending-only',
      labels: 'autorelease: pending\n',
      expectedStatus: 0,
      expected: 'autorelease: tagged\n',
    },
    {
      name: 'interrupted both-label transition',
      labels: 'autorelease: pending\nautorelease: tagged\n',
      expectedStatus: 0,
      expected: 'autorelease: tagged\n',
    },
    {
      name: 'tagged-only retry',
      labels: 'autorelease: tagged\n',
      expectedStatus: 0,
      expected: 'autorelease: tagged\n',
    },
    {
      name: 'publication failure',
      labels: 'autorelease: pending\n',
      failPublish: true,
      expectedStatus: 1,
      expected: 'autorelease: pending\n',
    },
    {
      name: 'post-publication lookup failure',
      labels: 'autorelease: pending\n',
      failLookup: true,
      expectedStatus: 1,
      expected: 'autorelease: tagged\n',
    },
  ])('keeps backend recovery retryable from $name', (scenario) => {
    const finalize = workflow.jobs['finalize-backend-release'];
    const publish = finalize.steps.find((step) => step.name === 'Publish verified backend release');
    const root = mkdtempSync(join(tmpdir(), 'verity-backend-release-label-'));
    try {
      const bin = join(root, 'bin');
      const labels = join(root, 'labels');
      const draft = join(root, 'draft');
      const views = join(root, 'views');
      const gh = join(bin, 'gh');
      mkdirSync(bin);
      writeFileSync(labels, scenario.labels);
      writeFileSync(draft, 'true\n');
      writeFileSync(views, '0\n');
      writeFileSync(
        gh,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "release view" ]]; then
  count="$(cat "$TEST_VIEWS")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$TEST_VIEWS"
  if [[ "\${FAIL_LOOKUP:-false}" == true && "$count" -gt 1 ]]; then exit 1; fi
  cat "$TEST_DRAFT"
elif [[ "$1 $2" == "release edit" ]]; then
  if [[ "\${FAIL_PUBLISH:-false}" == true ]]; then exit 1; fi
  printf 'false\\n' > "$TEST_DRAFT"
elif [[ "$1" == api && " $* " == *" --paginate "* ]]; then
  printf '406\\n'
elif [[ "$1" == api && "$2" == */issues/406/labels && " $* " != *" --method "* ]]; then
  cat "$TEST_LABELS"
elif [[ "$1 $2" == "api --method" && "$3" == POST ]]; then
  label="\${*: -1}"
  label="\${label#labels[]=}"
  grep -Fxq "$label" "$TEST_LABELS" || printf '%s\\n' "$label" >> "$TEST_LABELS"
elif [[ "$1 $2" == "api --method" && "$3" == DELETE ]]; then
  label="\${4##*/}"
  label="\${label//%3A/:}"
  label="\${label//%20/ }"
  grep -Fxv "$label" "$TEST_LABELS" > "$TEST_LABELS.next" || true
  mv "$TEST_LABELS.next" "$TEST_LABELS"
else
  printf 'unexpected gh invocation: %s\\n' "$*" >&2
  exit 2
fi
`,
      );
      chmodSync(gh, 0o755);

      const script =
        publish?.run
          ?.replace('${{ github.event_name }}', 'workflow_dispatch')
          .replace(
            '${{ inputs.backend-artifact-only }}',
            scenario.artifactOnly ? 'true' : 'false',
          ) ?? '';
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          TAG: 'v0.10.4',
          GITHUB_REPOSITORY: 'Heey-Global/verity',
          TEST_LABELS: labels,
          TEST_DRAFT: draft,
          TEST_VIEWS: views,
          FAIL_PUBLISH: scenario.failPublish ? 'true' : 'false',
          FAIL_LOOKUP: scenario.failLookup ? 'true' : 'false',
        },
      });
      expect(result.status, result.stderr).toBe(scenario.expectedStatus);
      expect(readFileSync(labels, 'utf8')).toBe(scenario.expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('release toolkit trust ledger', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;

  it.each(['prepare-server-build-context'] as const)(
    'assembles release boundary hashes in the trusted %s job',
    (jobName) => {
      const steps = workflow.jobs[jobName].steps;
      const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with?.ref).toBe('${{ needs.release-please.outputs.backend-sha }}');
      expect(checkout?.with?.['fetch-depth']).toBe(0);

      const setupNodeIndex = steps.findIndex((step) =>
        step.uses?.startsWith('actions/setup-node@'),
      );
      const assembleIndex = steps.findIndex(
        (step) => step.name === 'Assemble toolkit compatibility ledger',
      );
      expect(setupNodeIndex).toBeGreaterThan(-1);
      expect(assembleIndex).toBeGreaterThan(setupNodeIndex);
      const assemble = steps.find((step) => step.name === 'Assemble toolkit compatibility ledger');
      expect(assemble?.run).toBe('node scripts/update-toolkit-ledger.mjs');
    },
  );
});

describe('toolkit Feature manifest stamping', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;
  const manifestPath = 'features/verity-sandbox-toolkit/devcontainer-feature.json';
  const steps = workflow.jobs['publish-toolkit'].steps;
  const stampStep = steps.find((step) => step.name === 'Stamp release version into manifest');
  const channelStep = steps.find((step) => step.name === 'Publish toolkit channel tags');

  // Run the release's OWN stamping command over the committed manifest, so the
  // test sees the file devcontainers/action would be handed, not a copy of it.
  function stamp(): { manifest: Record<string, unknown>; sha: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'toolkit-stamp-'));
    mkdirSync(join(cwd, 'features/verity-sandbox-toolkit'), { recursive: true });
    writeFileSync(join(cwd, manifestPath), readFileSync(manifestPath, 'utf8'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgSign', 'false');
    git('add', '.');
    git('commit', '-qm', 'chore: fixture');
    const result = spawnSync('bash', ['-c', stampStep?.run ?? 'exit 1'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, VERSION: '9.9.9' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return {
      manifest: JSON.parse(readFileSync(join(cwd, manifestPath), 'utf8')),
      sha: git('rev-parse', 'HEAD'),
    };
  }

  it('adds no property the published Feature schema would reject', () => {
    // devcontainers/action validates devcontainer-feature.json against a schema
    // whose Feature definition is `additionalProperties: false`. A property the
    // release invents at publish time exists in no committed file, so every
    // local check stays green and the publish fails inside the release train —
    // after the sibling artifacts are pushed and the draft release is waiting on
    // a Server that now never builds. Stamping may only overwrite values that
    // the committed, schema-shaped manifest already declares.
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(stamp().manifest)).toEqual(Object.keys(committed));
  });

  it('writes the revision where the channel-tag step reads it back', () => {
    // The two halves are edited apart: one writes the annotation, the other
    // gates the immutable channel tags on it. Disagreeing about the JSON path
    // fails only in the release, and only after the Feature is already pushed.
    const { manifest, sha } = stamp();
    expect((manifest as { version: string }).version).toBe('9.9.9');
    const filter = /jq -e --arg sha "\$source_sha" '([^']+)'/.exec(channelStep?.run ?? '')?.[1];
    expect(filter).toBeDefined();
    const inspected = JSON.stringify({
      annotations: { 'dev.containers.metadata': JSON.stringify(manifest) },
    });
    const accepted = spawnSync('jq', ['-e', '--arg', 'sha', sha, filter ?? ''], {
      input: inspected,
      encoding: 'utf8',
    });
    expect(accepted.status).toBe(0);
    const rejected = spawnSync('jq', ['-e', '--arg', 'sha', 'f'.repeat(40), filter ?? ''], {
      input: inspected,
      encoding: 'utf8',
    });
    expect(rejected.status).toBe(1);
  });
});

describe('release immutability lifecycle', () => {
  it('creates every release as a draft, never published directly', () => {
    // Immutable releases must stay mutable until their artifacts and evidence
    // are complete. Pin every creation path to draft-then-publish so a new
    // train or workflow cannot silently bypass that lifecycle.
    for (const train of ['backend', 'mobile', 'website']) {
      const config = JSON.parse(readFileSync(`release-please-config.${train}.json`, 'utf8')) as {
        packages: Record<string, { draft?: boolean }>;
      };
      for (const [path, pkg] of Object.entries(config.packages)) {
        expect(pkg.draft, `${train}:${path} must create draft releases`).toBe(true);
      }
    }
    for (const file of readdirSync('.github/workflows')) {
      const source = readFileSync(`.github/workflows/${file}`, 'utf8');
      const flat = source.replace(/\\\n\s*/gu, ' ');
      for (const [command] of flat.matchAll(/gh release create[^\n]*/gu)) {
        expect(command, `${file} must create releases as drafts`).toContain('--draft');
        // Existing tags determine the release commit. Repeating it as --target
        // makes GitHub authorize a protected ref update and can 403 when the
        // tagged tree contains older workflow files.
        expect(command, `${file} must not retarget an existing release tag`).not.toContain(
          '--target',
        );
      }
    }
  });
});

describe('release train concurrency', () => {
  type Job = {
    needs?: string | string[];
    if?: string;
    uses?: string;
    strategy?: { matrix?: { train?: string[] }; 'fail-fast'?: boolean };
    concurrency?: { group?: string; queue?: string; 'cancel-in-progress'?: boolean };
    with?: Record<string, string>;
    permissions?: Record<string, string>;
    outputs?: Record<string, string>;
    steps?: WorkflowStep[];
  };
  type Workflow = {
    on: Record<string, unknown> & {
      workflow_call?: { inputs?: Record<string, { type: string; required?: boolean }> };
    };
    concurrency?: unknown;
    jobs: Record<string, Job>;
  };
  const trains = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow;
  const backend = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow;

  const dispatch = parse(
    readFileSync('.github/workflows/release-dispatch.yml', 'utf8'),
  ) as Workflow;

  it('holds each train lock from metadata through publication without cancelling queued releases', () => {
    // Locking publication alone lets a second metadata run recreate next-release
    // PRs against an unpublished draft; the entire train must own one lock.
    expect(dispatch.concurrency).toBeUndefined();
    expect(trains.concurrency).toBeUndefined();
    expect(backend.concurrency).toBeUndefined();
    const callers = Object.values(dispatch.jobs).filter(
      (job) => job.uses === './.github/workflows/release.yml',
    );
    expect(callers).toHaveLength(1);
    const caller = callers[0];
    expect(caller?.strategy?.matrix?.train).toEqual(['backend', 'mobile', 'website']);
    expect(caller?.strategy?.['fail-fast']).toBe(false);
    expect(caller?.concurrency).toEqual({
      group: 'release-${{ matrix.train }}',
      queue: 'max',
      'cancel-in-progress': false,
    });
    expect(caller?.with?.train).toBe('${{ matrix.train }}');
    expect(trains.jobs['release-please']?.concurrency).toEqual({
      group: 'release-metadata',
      queue: 'max',
      'cancel-in-progress': false,
    });
    for (const name of ['self-update-gate', 'publish-mobile-native', 'publish-website']) {
      expect(trains.jobs[name]?.needs).toBe('release-please');
      expect(trains.jobs[name]?.concurrency).toBeUndefined();
    }
    expect(
      Object.entries(backend.jobs)
        .filter(([name]) => name !== 'release-please')
        .every(([, job]) => job.concurrency === undefined),
    ).toBe(true);
    expect(Object.keys(caller?.with ?? {}).sort()).toEqual(
      Object.keys(trains.on.workflow_call?.inputs ?? {}).sort(),
    );
    for (const job of Object.values(trains.jobs)) {
      for (const [scope, access] of Object.entries(job.permissions ?? {})) {
        if (access === 'write') expect(caller?.permissions?.[scope], scope).toBe('write');
      }
    }
  });

  it('keeps every nested workflow permission within its caller grant', () => {
    type Permissions = Record<string, string>;
    type PermissionWorkflow = {
      permissions?: Permissions | string;
      jobs: Record<string, { permissions?: Permissions; uses?: string }>;
    };
    const rank: Record<string, number> = { none: 0, read: 1, write: 2 };
    const check = (file: string, allowed?: Permissions): void => {
      const workflow = parse(readFileSync(file, 'utf8')) as PermissionWorkflow;
      // read-all requests scopes omitted by an explicit caller, so GitHub
      // rejects the entire graph before Release Please gets a runner.
      expect(typeof workflow.permissions, file).not.toBe('string');
      const defaults = workflow.permissions as Permissions | undefined;
      const within = (requested: Permissions): void => {
        if (allowed === undefined) return;
        for (const [scope, access] of Object.entries(requested)) {
          expect(rank[access], `${file}: ${scope}`).toBeLessThanOrEqual(
            rank[allowed[scope] ?? 'none']!,
          );
        }
      };
      within(defaults ?? {});
      for (const job of Object.values(workflow.jobs)) {
        const effective = job.permissions ?? defaults ?? allowed ?? {};
        within(effective);
        if (job.uses?.startsWith('./.github/workflows/')) {
          check(job.uses.slice(2), effective);
        }
      }
    };
    for (const job of Object.values(dispatch.jobs)) {
      if (job.uses?.startsWith('./.github/workflows/')) {
        check(job.uses.slice(2), job.permissions);
      }
    }
  });

  it('runs only the selected train metadata action and recovery path', () => {
    const steps = trains.jobs['release-please']?.steps ?? [];
    const actions = steps.filter((step) =>
      step.uses?.startsWith('googleapis/release-please-action@'),
    );
    expect(actions).toHaveLength(3);
    for (const train of ['backend', 'mobile', 'website']) {
      const action = actions.find((step) => step.id === `release-${train}`);
      expect(action?.if).toContain(`inputs.train == '${train}'`);
    }
    expect(steps.find((step) => step.id === 'maintenance')?.if).toContain(
      "inputs.train == 'backend'",
    );
    expect(steps.find((step) => step.id === 'website-recovery')?.if).toContain(
      "inputs.train == 'website'",
    );
    expect(trains.jobs['publish-mobile-native']?.if).toContain("inputs.train == 'mobile'");
  });

  it('validates the exact backend outputs before publication', () => {
    const metadata = backend.jobs['release-please'];
    const guard = metadata?.steps?.find((step) => step.id === 'validate-backend');
    expect(guard?.env?.VERSION).toBe(metadata?.outputs?.['backend-version']);
    expect(guard?.env?.SHA).toBe(metadata?.outputs?.['backend-sha']);
    expect(guard?.run).toBeDefined();
    for (const [version, sha, valid] of [
      ['0.10.4', 'a'.repeat(40), true],
      ['0.10', 'a'.repeat(40), false],
      ['0.10.4', 'main', false],
      ['0.10.4', 'a'.repeat(39), false],
    ] as const) {
      const result = spawnSync('bash', ['-c', guard!.run!], {
        env: { ...process.env, VERSION: version, SHA: sha },
      });
      expect(result.status === 0, version + '/' + sha).toBe(valid);
    }
  });

  it('keeps signing and publication in the directly called release workflow', () => {
    const caller = dispatch.jobs['release-train'];
    expect(caller?.uses).toBe('./.github/workflows/release.yml');
    expect(Object.keys(backend.on)).toEqual(['workflow_call']);
    expect(dispatch.on.push).toBeDefined();
    expect(dispatch.on.workflow_dispatch).toBeDefined();
    expect(backend.jobs['publish-backend']).toBeUndefined();
    expect(backend.jobs['publish-server']).toBeDefined();
    expect(backend.jobs['finalize-backend-release']).toBeDefined();
    expect(backend.jobs['self-update-gate']?.uses).toBe('./.github/workflows/self-update.yml');
    // Removing the handoff must not turn every metadata invocation into a release.
    expect(backend.jobs['release-please']?.outputs?.['backend-release-created']).not.toBe('true');
    const callees = Object.values(backend.jobs).flatMap((job) => (job.uses ? [job.uses] : []));
    expect(callees).toEqual(['./.github/workflows/self-update.yml']);
  });
});

describe('planning resumes after publication', () => {
  type Job = {
    if?: string;
    uses?: string;
    env?: Record<string, string>;
    permissions?: Record<string, string>;
    with?: Record<string, string>;
    steps?: WorkflowStep[];
  };
  type Workflow = { jobs: Record<string, Job> };
  const dispatchFile = 'release-dispatch.yml';
  const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow;
  const dispatch = parse(readFileSync(`.github/workflows/${dispatchFile}`, 'utf8')) as Workflow;
  // Whatever it is named, the backend publisher is the job that clears a draft
  // it identifies by the planned backend version.
  const publishers = Object.entries(release.jobs).filter(
    ([, job]) =>
      job.steps?.some((step) => step.run?.includes('--draft=false')) &&
      Object.values(job.env ?? {}).some((value) => value.includes('backend-version')),
  );

  it('dispatches a planning run from the job that clears the draft', () => {
    // A push runs either planning or publication, never both, and no schedule
    // reconciles the difference. Losing this dispatch leaves every commit
    // merged before a release without a release PR until an unrelated later
    // push happens to plan one — no failed run, no draft, nothing to notice.
    expect(publishers).toHaveLength(1);
    const [name, job] = publishers[0]!;
    const replan = job.steps?.filter((step) => step.run?.includes('gh workflow run')) ?? [];
    expect(replan, `${name} must dispatch the follow-up planning run`).toHaveLength(1);
    expect(replan[0]?.run).toContain(dispatchFile);
    expect(replan[0]?.run).toContain('backend-replan=true');
    // Recovery publishes an older draft; only the push lifecycle that produced
    // this release may plan the next one against current main.
    expect(replan[0]?.if).toContain("github.event_name == 'push'");
    expect(job.permissions?.actions).toBe('write');
  });

  it('keeps a dispatched re-plan in planning mode only', () => {
    const steps = release.jobs['release-please']?.steps ?? [];
    const reachable = steps.filter(
      (step) =>
        step.uses?.startsWith('googleapis/release-please-action@') &&
        step.if?.includes('backend-replan'),
    );
    // Only the backend train may be planned this way: the mobile train decides
    // between OTA and native from the push diff, which a manual run has not got.
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.id).toBe('release-backend');
    expect(reachable[0]?.if).toContain(
      "inputs.backend-replan && steps.lifecycle.outputs.mode == 'plan'",
    );
    expect(dispatch.jobs['release-train']?.with?.['backend-replan']).toContain(
      "matrix.train == 'backend'",
    );
  });

  it('refuses a re-plan that carries any recovery input', () => {
    const guard = release.jobs['release-please']?.steps?.find(
      (step) => step.name === 'Validate backend re-plan request',
    );
    expect(guard?.run).toBeDefined();
    const accepted = { REPLAN: 'true', EVENT_NAME: 'workflow_dispatch' };
    for (const [overrides, valid] of [
      [{}, true],
      [{ REPLAN: 'false', EVENT_NAME: 'push' }, true],
      [{ EVENT_NAME: 'push' }, false],
      [{ VERSION: '1.2.3' }, false],
      [{ SOURCE_REF: 'main' }, false],
      [{ MOBILE_TAG: 'mobile-v1.33.0' }, false],
      [{ WEBSITE_VERSION: '1.2.3' }, false],
      [{ WEBSITE_REF: 'main' }, false],
      [{ SCHEMA_FORWARD_MAX: '0042_x' }, false],
      [{ REPUBLISH: 'true' }, false],
      [{ ARTIFACT_ONLY: 'true' }, false],
      [{ ACCEPT_NO_ROLLBACK: 'true' }, false],
    ] as const) {
      const env: Record<string, string> = {
        ...process.env,
        MOBILE_TAG: '',
        VERSION: '',
        SOURCE_REF: '',
        SCHEMA_FORWARD_MAX: '',
        REPUBLISH: 'false',
        ARTIFACT_ONLY: 'false',
        ACCEPT_NO_ROLLBACK: 'false',
        WEBSITE_VERSION: '',
        WEBSITE_REF: '',
        ...accepted,
        ...overrides,
      };
      const result = spawnSync('bash', ['-c', guard!.run!], { env });
      expect(result.status === 0, JSON.stringify(overrides)).toBe(valid);
    }
  });
});
