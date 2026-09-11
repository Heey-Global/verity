import { readFileSync } from 'node:fs';

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
    'publish-project-relay': {
      outputs?: Record<string, string>;
      steps: WorkflowStep[];
    };
    'publish-toolkit': {
      steps: WorkflowStep[];
    };
    'publish-server': {
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
    const push = steps.find((step) => step.id === 'push-relay');
    expect(push?.uses).toContain('docker/build-push-action@');

    const record = steps.find((step) => step.name === 'Record digest-pinned relay reference');
    expect(record?.env?.RELAY_DIGEST).toBe('${{ steps.push-relay.outputs.digest }}');
    expect(record?.run).toContain('^sha256:[a-f0-9]{64}$');
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
    ]);
    // …and every one of them runs under the same condition, so the added
    // dependencies only order jobs that were going to run anyway.
    for (const name of server.needs.slice(1)) {
      expect(workflow.jobs[name]?.if).toBe(server.if);
    }

    const build = server.steps.find((step) => step.name === 'Build + push (linux/amd64)');
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
    const server = workflow.jobs['publish-server'];
    const resolve = server.steps.find((step) => step.name === 'Resolve the bundled PostgreSQL pin');
    expect(resolve?.id).toBe('postgres');
    // Read out of the compose file, so the line Renovate bumps stays the one
    // source of truth and cannot drift from what a fresh install bootstraps.
    expect(resolve?.run).toContain('deploy/docker-compose.yml');

    const build = server.steps.find((step) => step.name === 'Build + push (linux/amd64)');
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

describe('signed GitHub release evidence', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;
  const server = workflow.jobs['publish-server'];
  const evidence = workflow.jobs['publish-server-release-evidence'];

  it('passes the verified channel payload to a narrow release writer', () => {
    const upload = server.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(upload?.with?.path).toContain('.release-channel.sigstore.json');
    expect(upload?.with?.path).toContain('.intoto.jsonl');

    expect(evidence.needs).toEqual(['release-please', 'publish-server']);
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
    const channel = server.steps.find((step) => step.name === 'Publish the signed release channel');
    expect(channel?.run).toContain('cosign verify-attestation');
    expect(channel?.run).toContain('https://slsa.dev/provenance/v1');
  });

  it('keeps the release mutable until its evidence and artifacts are complete', () => {
    const backend = JSON.parse(readFileSync('release-please-config.backend.json', 'utf8')) as {
      packages: Record<string, { draft?: boolean }>;
    };
    expect(Object.values(backend.packages)[0]?.draft).toBe(true);

    const finalize = workflow.jobs['finalize-backend-release'];
    expect(finalize.needs).toContain('publish-server-release-evidence');
    const publish = finalize.steps.find((step) => step.name === 'Publish verified backend release');
    expect(publish?.run).toContain('--json isDraft');
    expect(publish?.run).toContain('--draft=false');
  });
});

describe('release toolkit trust ledger', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as ReleaseWorkflow;

  it.each(['publish-toolkit', 'publish-server'] as const)(
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
