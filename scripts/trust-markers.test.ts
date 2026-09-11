import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// The README badge row and the "Verifying a release" instructions are claims
// made to a reader who cannot see this repository's internals. Every one of them
// fails silently: a badge whose workflow was renamed renders a grey "no status"
// nobody on the team looks at, and a `cosign verify` command carrying a stale
// identity fails for an outside verifier in a way that is indistinguishable from
// a forged artifact. Nothing else in CI reads these files.

const README = readFileSync('README.md', 'utf8');
const SECURITY = readFileSync('SECURITY.md', 'utf8');

/** The compiled-in release identity. Read out of the source the Server actually
 *  verifies against rather than imported, so the values this test compares the
 *  documentation to are the literals a reviewer sees in that file. */
const releaseConstant = (file: string, name: string): string => {
  const source = readFileSync(join('packages/server/src/self-update', file), 'utf8');
  const match = new RegExp(`export const ${name} = '([^']+)'`, 'u').exec(source);
  expect(match?.[1], `${name} is no longer a string literal in ${file}`).toBeTruthy();
  return match?.[1] ?? '';
};

const OFFICIAL_SOURCE_REPOSITORY = releaseConstant(
  'release-channel-verify.ts',
  'OFFICIAL_SOURCE_REPOSITORY',
);
const OFFICIAL_SOURCE_REF = releaseConstant('release-channel-verify.ts', 'OFFICIAL_SOURCE_REF');
const OFFICIAL_CERTIFICATE_ISSUER = releaseConstant(
  'release-channel-verify.ts',
  'OFFICIAL_CERTIFICATE_ISSUER',
);
const OFFICIAL_SERVER_IMAGE = releaseConstant('release-channel.ts', 'OFFICIAL_SERVER_IMAGE');
const OFFICIAL_RELEASE_WORKFLOW_IDENTITY = `${OFFICIAL_SOURCE_REPOSITORY}/.github/workflows/release.yml@${OFFICIAL_SOURCE_REF}`;
/** `Heey-Global/verity`, from the one place that spells the repository out. */
const REPOSITORY_SLUG = OFFICIAL_SOURCE_REPOSITORY.replace('https://github.com/', '');

describe('README trust badges', () => {
  const badges = [
    ...README.matchAll(/\[!\[(?<alt>[^\]]+)\]\((?<image>[^)]+)\)\]\((?<href>[^)]+)\)/gu),
  ].map((match) => ({
    alt: match.groups?.alt ?? '',
    image: match.groups?.image ?? '',
    href: match.groups?.href ?? '',
  }));

  it('finds the badge row', () => {
    // Guards the guard: reformatted or removed badges would make every assertion
    // below pass by matching nothing at all.
    expect(badges.map((badge) => badge.alt)).toEqual([
      'CI',
      'OpenSSF Scorecard',
      'Server release',
      'Signed releases',
      'License',
    ]);
  });

  it('points every badge at this repository', () => {
    // A badge copied from another project renders perfectly and reports someone
    // else's build. The failure is invisible precisely because it is green.
    const foreign = badges
      .flatMap((badge) => [badge.image, badge.href])
      .filter((url) => /github\.com|scorecard\.dev|shields\.io/u.test(url))
      .filter(
        (url) => url.includes('/') && !url.toLowerCase().includes(REPOSITORY_SLUG.toLowerCase()),
      )
      .filter((url) => !url.startsWith('https://img.shields.io/badge/'));
    expect(foreign).toEqual([]);
  });

  it('names a workflow that exists and runs on the branch the badge claims', () => {
    const workflowBadges = badges
      .map((badge) => ({
        alt: badge.alt,
        file: /actions\/workflows\/(?<file>[^/]+)\/badge\.svg/u.exec(badge.image)?.groups?.file,
        branch: /badge\.svg\?branch=(?<branch>[^&)]+)/u.exec(badge.image)?.groups?.branch,
      }))
      .filter((badge) => badge.file !== undefined);
    expect(workflowBadges.length, 'no workflow badge to check').toBeGreaterThan(0);

    for (const badge of workflowBadges) {
      const path = join('.github/workflows', badge.file ?? '');
      expect(existsSync(path), `${badge.alt} badge names a workflow that does not exist`).toBe(
        true,
      );
      // A badge pinned to a branch the workflow never runs on is permanently
      // grey. A badge with no branch at all reports the last run on any branch,
      // which on this repository means a pull request's result shown as main's.
      const workflow = parse(readFileSync(path, 'utf8')) as {
        on?: { push?: { branches?: string[] } };
      };
      expect(workflow.on?.push?.branches ?? [], `${badge.alt} badge`).toContain(badge.branch);
    }
  });

  it('filters the release badge to the backend train', () => {
    // Three release-please trains tag this repository. The backend train omits
    // the component prefix, so its tags are the only bare `vX.Y.Z` — without the
    // filter the badge shows whichever train released last, and a mobile release
    // silently relabels the Server version an installer is meant to read.
    const config = JSON.parse(readFileSync('release-please-config.backend.json', 'utf8')) as {
      packages: Record<string, { 'include-component-in-tag'?: boolean }>;
    };
    const backend = Object.values(config.packages)[0];
    expect(backend?.['include-component-in-tag'], 'the backend tag format moved').toBe(false);

    const release = badges.find((badge) => badge.alt === 'Server release');
    expect(release?.image).toContain('filter=v*');
  });

  it('links to a heading that exists', () => {
    // A `#fragment` that no longer resolves scrolls the reader to the top of the
    // page — a broken link that renders as a working one.
    const anchors = new Set(
      [...SECURITY.matchAll(/^#{2,}\s+(?<title>.+)$/gmu)].map((match) =>
        (match.groups?.title ?? '')
          .toLowerCase()
          .replaceAll(/[^\w\s-]/gu, '')
          .trim()
          .replaceAll(/\s+/gu, '-'),
      ),
    );
    const fragments = badges
      .map((badge) => /^SECURITY\.md#(?<fragment>.+)$/u.exec(badge.href)?.groups?.fragment)
      .filter((fragment): fragment is string => fragment !== undefined);
    expect(fragments.length, 'no SECURITY.md deep link to check').toBeGreaterThan(0);
    expect(fragments.filter((fragment) => !anchors.has(fragment))).toEqual([]);
  });
});

describe('OpenSSF Scorecard publication', () => {
  const workflow = parse(readFileSync('.github/workflows/scorecard.yml', 'utf8')) as {
    on?: Record<string, unknown>;
    jobs?: Record<
      string,
      {
        permissions?: Record<string, string>;
        steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
      }
    >;
  };
  const job = workflow.jobs?.analysis;
  const scorecard = (job?.steps ?? []).find((step) =>
    step.uses?.startsWith('ossf/scorecard-action@'),
  );

  it('runs the analyser', () => {
    // Guards the guard.
    expect(scorecard, 'the scorecard step moved or was removed').toBeDefined();
  });

  it('publishes the result the README badge reads', () => {
    // The badge is served from OpenSSF's API, not from this repository. Drop
    // `publish_results` and the workflow still runs green, still uploads SARIF,
    // and the badge freezes on the last published score — or never renders at
    // all. `id-token` is the other half: without it the publication is unsigned
    // and the API refuses it, with the same silent outcome.
    expect(scorecard?.with?.publish_results).toBe(true);
    expect(job?.permissions?.['id-token']).toBe('write');
    expect(README).toContain(`api.scorecard.dev/projects/github.com/${REPOSITORY_SLUG}/badge`);
  });

  it('runs on the default branch, which is the only place publication takes effect', () => {
    const push = workflow.on?.push as { branches?: string[] } | undefined;
    expect(push?.branches ?? []).toContain(OFFICIAL_SOURCE_REF.replace('refs/heads/', ''));
  });
});

describe('release verification instructions', () => {
  it('documents the identity the Server actually pins', () => {
    // The Server compiles this identity in and refuses anything else (ADR 0008
    // D4). If it changes and SECURITY.md does not, every outside verifier
    // following these steps gets a cryptographic failure on a genuine release —
    // which reads exactly like a compromised one.
    expect(SECURITY).toContain(OFFICIAL_RELEASE_WORKFLOW_IDENTITY);
    expect(SECURITY).toContain(OFFICIAL_CERTIFICATE_ISSUER);
    expect(SECURITY).toContain(OFFICIAL_SERVER_IMAGE);
    expect(SECURITY).toContain(`--certificate-github-workflow-repository ${REPOSITORY_SLUG}`);
    expect(SECURITY).toContain(`--certificate-github-workflow-ref ${OFFICIAL_SOURCE_REF}`);
  });

  it('names the image the release workflow signs', () => {
    // Found by the signing step rather than by job name: the documentation is
    // only correct while the image cosign is pointed at is the image the reader
    // is told to verify.
    const release = parse(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs?: Record<string, { env?: Record<string, string>; steps?: Array<{ run?: string }> }>;
    };
    const signing = Object.values(release.jobs ?? {}).filter((job) =>
      (job.steps ?? []).some((step) => /cosign sign\s/u.test(step.run ?? '')),
    );
    expect(signing.length, 'no job signs an image, so this guards nothing').toBe(1);
    const env = signing[0]?.env ?? {};
    expect(`${env.REGISTRY}/${env.IMAGE_NAME}`).toBe(OFFICIAL_SERVER_IMAGE);
  });

  it('tells the reader how to reach the signed channel document', () => {
    // The document is an ORAS artifact under a tag no registry UI lists. Without
    // the pull command the verify command below it cannot be run at all.
    expect(SECURITY).toContain(`oras pull ${OFFICIAL_SERVER_IMAGE}:channel-stable-amd64`);
    const publish = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(publish, 'the channel tag moved').toContain('channel-stable-amd64');
  });

  it('documents verification of the Server provenance the release publishes', () => {
    const publish = readFileSync('.github/workflows/release.yml', 'utf8');
    expect(publish).toContain('actions/attest@');
    expect(publish).toContain('.intoto.jsonl');
    expect(SECURITY).toContain('gh attestation verify');
    expect(SECURITY).toContain('oci://$(jq -r .serverImage payload.json)');
  });
});
