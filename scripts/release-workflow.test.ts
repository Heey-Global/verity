import { readFileSync, readdirSync } from 'node:fs';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
}

interface ReleaseWorkflow {
  jobs: {
    'build-project-relay': {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'build-sandbox': {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'build-server': {
      if?: string;
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'prepare-server-build-context': {
      steps: WorkflowStep[];
    };
    'build-preview-images': {
      strategy?: { matrix?: { include?: Array<Record<string, string>> } };
      steps: WorkflowStep[];
    };
    'publish-project-relay': {
      outputs?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'publish-toolkit': {
      steps: WorkflowStep[];
    };
    'publish-sandbox': {
      steps: WorkflowStep[];
    };
    'publish-server': {
      outputs?: Record<string, string>;
      needs?: string[];
      permissions?: Record<string, string>;
      steps: WorkflowStep[];
    };
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
    expect(sandbox?.run).toContain('${REGISTRY}/${IMAGE_NAME}:sha-${short_sha}-amd64');
    expect(sandbox?.run).toContain('${REGISTRY}/${IMAGE_NAME}:sha-${short_sha}-arm64');
    expect(sandbox?.run).toContain('${REGISTRY}/${IMAGE_NAME_NEW}:sha-${short_sha}-amd64');
    expect(sandbox?.run).toContain('${REGISTRY}/${IMAGE_NAME_NEW}:sha-${short_sha}-arm64');

    const relay = workflow.jobs['publish-project-relay'].steps.find(
      (step) => step.name === 'Publish multi-architecture relay index',
    );
    expect(relay?.run).toContain('${image}:sha-${short_sha}-amd64');
    expect(relay?.run).toContain('${image}:sha-${short_sha}-arm64');
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

  it('pre-tags only delayed release commits whose workflow tree changed', () => {
    const steps = workflow.jobs['release-please'].steps;
    const pretagIndex = steps.findIndex((step) => step.name === 'Pre-tag delayed release commits');
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
    expect(pretag?.run).toContain('git push origin "refs/tags/${tag}"');
    expect(pretag?.run).toContain("'.release/backend' v");
    expect(pretag?.run).toContain("'apps/mobile' mobile-v");
    expect(pretag?.run).toContain("'docs/website' website-v");
  });
});

describe('website release recovery', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
    on: { workflow_dispatch?: { inputs?: Record<string, { type?: string }> } };
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
    expect(workflow.on.workflow_dispatch?.inputs?.['website-version']?.type).toBe('string');
    expect(workflow.on.workflow_dispatch?.inputs?.['website-ref']?.type).toBe('string');
    const step = workflow.jobs['release-please'].steps.find(
      (candidate) => candidate.id === 'website-recovery',
    );
    expect(step?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(step?.if).toContain("inputs['website-version'] != ''");
    expect(step?.run).toContain('website-ref is required with website-version');
  });

  it('requires an existing published release bound to the requested source', () => {
    const step = workflow.jobs['release-please'].steps.find(
      (candidate) => candidate.id === 'website-recovery',
    );
    expect(step?.run).toContain('gh release view "$tag" --json isDraft');
    expect(step?.run).toContain('[[ "$is_draft" != \'false\' ]]');
    expect(step?.run).toContain('git/ref/tags/${tag}');
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
    expect(publish?.if).toContain("inputs['website-version'] == ''");
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
  const channels = workflow.jobs['publish-server-channels'];
  const evidence = workflow.jobs['publish-server-release-evidence'];

  it('passes the verified channel payload to a narrow release writer', () => {
    const upload = channels.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload?.with?.path).toContain('.${{ matrix.architecture }}.*');

    expect(evidence.needs).toEqual(['release-please', 'publish-server-channels']);
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
      (step) => step.name === 'Publish signed architecture release channel',
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
      (step) => step.name === 'Publish signed architecture release channel',
    );
    expect(publish?.run).toContain('imagetools inspect --raw');
    expect(publish?.run).toContain('.platform.architecture == $architecture');
    expect(publish?.run).toContain('--platform "linux/${ARCHITECTURE}"');
    expect(publish?.run).toContain('VERITY_RELEASE_ARCHITECTURE="$ARCHITECTURE"');
    expect(publish?.run).toContain('channel-stable-${ARCHITECTURE}');
    expect(publish?.run).toContain('.${ARCHITECTURE}.release-channel.json');
    expect(publish?.run).toContain('cd "$workdir"');
    expect(publish?.run).toContain('channel.json:application/json');
    expect(publish?.run).not.toContain('"$workdir/channel.json":application/json');
  });

  it('keeps the release mutable until its evidence and artifacts are complete', () => {
    const backend = JSON.parse(readFileSync('release-please-config.backend.json', 'utf8')) as {
      packages: Record<string, { draft?: boolean }>;
    };
    expect(Object.values(backend.packages)[0]?.draft).toBe(true);

    const finalize = workflow.jobs['finalize-backend-release'];
    expect(finalize.env?.GH_REPO).toBe('${{ github.repository }}');
    expect(finalize.needs).toContain('publish-server-release-evidence');
    const publish = finalize.steps.find((step) => step.name === 'Publish verified backend release');
    expect(publish?.run).toContain('--json isDraft');
    expect(publish?.run).toContain('--draft=false');
  });
});

describe('release toolkit trust ledger', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;

  it.each(['publish-toolkit', 'prepare-server-build-context'] as const)(
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

describe('release immutability lifecycle', () => {
  it('creates every release as a draft, never published directly', () => {
    // Organization-enforced release immutability rejects a direct non-draft
    // create from the integration token with HTTP 403 — on release day, not
    // in CI. This pins every creation path to the draft-then-publish
    // lifecycle so a new train or workflow cannot silently reintroduce one.
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
      }
    }
  });
});
