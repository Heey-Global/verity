import { createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface ServerPromotion {
  schema: 1;
  product: 'server';
  version: string;
  source: string;
  releasePr: number;
  envelopes: Record<'amd64' | 'arm64', string>;
  images: Record<string, string>;
}
export function validateServerPromotion(value: unknown): ServerPromotion {
  const candidate = value as ServerPromotion;
  if (
    !candidate ||
    candidate.schema !== 1 ||
    candidate.product !== 'server' ||
    !/^\d+\.\d+\.\d+$/.test(candidate.version) ||
    !/^[a-f0-9]{40}$/.test(candidate.source) ||
    !Number.isSafeInteger(candidate.releasePr) ||
    candidate.releasePr < 1 ||
    !candidate.images ||
    Object.keys(candidate.images).sort().join() !==
      [
        'verity-server',
        'verity-sandbox',
        'verity-project-relay',
        'verity-preview-edge',
        'verity-preview-connector',
        'verity-matrix-connector',
        'verity-sandbox-toolkit',
      ]
        .sort()
        .join() ||
    Object.entries(candidate.images).some(
      ([name, ref]) =>
        typeof ref !== 'string' ||
        !ref.startsWith(`ghcr.io/heey-global/verity/${name}@sha256:`) ||
        !/^[a-f0-9]{64}$/.test(ref.slice(`ghcr.io/heey-global/verity/${name}@sha256:`.length)),
    ) ||
    !candidate.envelopes ||
    Object.keys(candidate.envelopes).sort().join() !== 'amd64,arm64' ||
    Object.values(candidate.envelopes).some(
      (ref) => !/^ghcr\.io\/heey-global\/verity\/verity-server@sha256:[a-f0-9]{64}$/.test(ref),
    )
  )
    throw new Error('Invalid Server production candidate');
  return candidate;
}
const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const gh = (...args: string[]) => run('gh', ...args);
const api = <T>(...args: string[]): T => JSON.parse(gh('api', ...args)) as T;
const repo = () => {
  const value = process.env.GITHUB_REPOSITORY;
  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new Error('Missing repository');
  return value;
};
const manifest = 'releases/server-production.json';
const branch = 'automation/promote-server-production';

function propose() {
  const raw = JSON.parse(readFileSync(process.argv[3] ?? '', 'utf8')) as { product?: string };
  const candidate =
    raw.product === 'mobile-native' ? validateNativePromotion(raw) : validateServerPromotion(raw);
  const manifest =
    candidate.product === 'server'
      ? 'releases/server-production.json'
      : 'releases/mobile-production.json';
  const branch =
    candidate.product === 'server'
      ? 'automation/promote-server-production'
      : 'automation/promote-mobile-production';
  const product = candidate.product === 'server' ? 'Server' : 'Mobile';
  const tag =
    candidate.product === 'server' ? `v${candidate.version}` : `mobile-v${candidate.version}`;
  const recordPath = `${process.env.RUNNER_TEMP ?? '/tmp'}/production-candidate.json`;
  writeFileSync(recordPath, JSON.stringify(candidate, null, 2) + '\n');
  const release = JSON.parse(gh('release', 'view', tag, '--json', 'assets')) as {
    assets: { name: string }[];
  };
  if (release.assets.some((asset) => asset.name === 'production-candidate.json')) {
    const recorded = gh(
      'release',
      'download',
      tag,
      '--pattern',
      'production-candidate.json',
      '--output',
      '-',
    );
    if (JSON.stringify(JSON.parse(recorded)) !== JSON.stringify(candidate))
      throw new Error('Release candidate already has different production evidence');
  } else gh('release', 'upload', tag, recordPath);

  const repository = repo();
  const main = api<{ object: { sha: string } }>(`repos/${repository}/git/ref/heads/main`).object
    .sha;
  const remote = run('git', 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
  let head = main;
  if (remote) {
    head = remote.split(/\s+/)[0]!;
    run(
      'git',
      'fetch',
      'origin',
      `${branch}:refs/remotes/origin/${branch}`,
      'main:refs/remotes/origin/main',
    );
    const changes = run('git', 'diff', '--name-only', `origin/main...origin/${branch}`)
      .split('\n')
      .filter(Boolean);
    if (changes.some((path) => path !== manifest))
      throw new Error('Existing promotion branch contains unrelated changes');
    const owner = JSON.parse(
      gh('pr', 'list', '--head', branch, '--state', 'all', '--json', 'author'),
    ) as { author: { login: string } }[];
    if (
      owner.length &&
      owner.some((pr) => !['app/github-actions', 'github-actions[bot]'].includes(pr.author.login))
    )
      throw new Error('Promotion branch is not workflow-owned');
  } else {
    api(
      `repos/${repository}/git/refs`,
      '--method',
      'POST',
      '-f',
      `ref=refs/heads/${branch}`,
      '-f',
      `sha=${head}`,
    );
  }
  const hasManifest = remote && run('git', 'ls-tree', '--name-only', `origin/${branch}`, manifest);
  const existing = hasManifest ? run('git', 'show', `origin/${branch}:${manifest}`) : '';
  if (!existing || JSON.stringify(JSON.parse(existing)) !== JSON.stringify(candidate)) {
    const query =
      'mutation($repository: String!, $branch: String!, $expected: GitObjectID!, $message: String!, $path: String!, $contents: Base64String!) { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: $repository, branchName: $branch }, expectedHeadOid: $expected, message: { headline: $message }, fileChanges: { additions: [{path: $path, contents: $contents}] } }) { commit { oid signature { isValid } } } }';
    const result = api<{
      data: { createCommitOnBranch: { commit: { signature: { isValid: boolean } } } };
    }>(
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `repository=${repository}`,
      '-f',
      `branch=${branch}`,
      '-f',
      `expected=${head}`,
      '-f',
      `message=chore(release): promote ${product} ${candidate.version}`,
      '-f',
      `path=${manifest}`,
      '-f',
      `contents=${Buffer.from(JSON.stringify(candidate, null, 2) + '\n').toString('base64')}`,
    );
    if (!result.data.createCommitOnBranch.commit.signature.isValid)
      throw new Error('Unsigned promotion commit');
  }
  const pulls = JSON.parse(
    gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'),
  ) as { number: number }[];
  if (pulls.length > 1) throw new Error('Multiple production PRs');
  const title = `chore(release): promote ${product} ${candidate.version}`;
  const bodyFile = `${process.env.RUNNER_TEMP ?? '/tmp'}/server-production-pr.md`;
  writeFileSync(
    bodyFile,
    `Promotes the verified Staging candidate ${candidate.version} to production.\n\nSource: ${candidate.source}\n\nMerging approves the exact recorded artifacts in ${manifest}. Test Staging before merging. The release remains a prerelease until production publication finishes.\n`,
  );
  if (pulls.length)
    gh('pr', 'edit', String(pulls[0]!.number), '--title', title, '--body-file', bodyFile);
  else
    gh(
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      title,
      '--body-file',
      bodyFile,
    );
  const current = api<{ object: { sha: string } }>(`repos/${repository}/git/ref/heads/${branch}`)
    .object.sha;
  const open = JSON.parse(
    gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'number'),
  ) as { number: number }[];
  for (const pr of open) {
    const reviews = api<{ id: number; state: string; commit_id: string }[][]>(
      '--paginate',
      '--slurp',
      `repos/${repository}/pulls/${pr.number}/reviews?per_page=100`,
    ).flat();
    for (const review of reviews.filter((r) => r.state === 'APPROVED' && r.commit_id !== current))
      api(
        `repos/${repository}/pulls/${pr.number}/reviews/${review.id}/dismissals`,
        '--method',
        'PUT',
        '-f',
        'message=The production candidate changed. Review the current candidate again.',
      );
  }
  gh('workflow', 'run', 'ci.yml', '--ref', branch);
}

function promote() {
  const candidate = validateServerPromotion(JSON.parse(readFileSync(manifest, 'utf8')));
  const repository = repo();
  assertReviewed(manifest, branch, candidate);
  assertRecorded(`v${candidate.version}`, candidate);
  run('git', 'merge-base', '--is-ancestor', candidate.source, 'HEAD');
  const releasePr = api<{
    merged_at: string | null;
    head: { ref: string };
    base: { ref: string };
    merge_commit_sha: string;
  }>(`repos/${repository}/pulls/${candidate.releasePr}`);
  if (
    !releasePr.merged_at ||
    releasePr.head.ref !== 'release-please--branches--main--components--server' ||
    releasePr.base.ref !== 'main'
  )
    throw new Error('Candidate is not backed by a merged Server release PR');
  const versionManifest = api<{ content: string }>(
    `repos/${repository}/contents/.release-please-manifest.backend.json?ref=${releasePr.merge_commit_sha}`,
  );
  const releaseVersion = JSON.parse(
    Buffer.from(versionManifest.content, 'base64').toString(),
  ) as Record<string, unknown>;
  if (releaseVersion['.'] !== candidate.version) throw new Error('Release PR version differs');
  for (const architecture of ['amd64', 'arm64'] as const) {
    const directory = mkdtempSync(
      `${process.env.RUNNER_TEMP ?? '/tmp'}/production-${architecture}-`,
    );
    run('oras', 'pull', candidate.envelopes[architecture], '-o', directory);
    const envelope = JSON.parse(readFileSync(`${directory}/channel.json`, 'utf8')) as {
      payload: string;
      signature: { bundle: string };
    };
    const payload = Buffer.from(envelope.payload, 'base64');
    const metadata = JSON.parse(payload.toString()) as {
      channel: string;
      version: string;
      revision: string;
      serverImage: string;
      architecture: string;
    };
    if (
      metadata.serverImage !== candidate.images['verity-server'] ||
      metadata.channel !== 'stable' ||
      metadata.version !== candidate.version ||
      metadata.architecture !== architecture ||
      metadata.revision !== candidate.source
    )
      throw new Error('Signed candidate differs from approval');
    writeFileSync(`${directory}/payload.json`, payload);
    writeFileSync(`${directory}/bundle.json`, Buffer.from(envelope.signature.bundle, 'base64'));
    run(
      'cosign',
      'verify-blob',
      '--bundle',
      `${directory}/bundle.json`,
      '--certificate-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--certificate-identity',
      `https://github.com/${repository}/.github/workflows/release.yml@refs/heads/main`,
      '--certificate-github-workflow-sha',
      candidate.source,
      `${directory}/payload.json`,
    );
  }
  for (const architecture of ['amd64', 'arm64'] as const) {
    const directory = mkdtempSync(`${process.env.RUNNER_TEMP ?? '/tmp'}/stable-${architecture}-`);
    run(
      'oras',
      'pull',
      `ghcr.io/heey-global/verity/verity-server:channel-stable-${architecture}`,
      '-o',
      directory,
    );
    const envelope = JSON.parse(readFileSync(`${directory}/channel.json`, 'utf8')) as {
      payload: string;
    };
    const current = JSON.parse(Buffer.from(envelope.payload, 'base64').toString()) as {
      version: string;
      revision: string;
    };
    assertPromotionOrder(current, candidate);
  }
  // Legacy consumers also use latest and toolkit semver aliases. They move only here.
  for (const [name, reference] of Object.entries(candidate.images)) {
    run('oras', 'cp', reference, `ghcr.io/heey-global/verity/${name}:latest`);
    if (name === 'verity-sandbox-toolkit') {
      const [major, minor] = candidate.version.split('.');
      run('oras', 'cp', reference, `ghcr.io/heey-global/verity/${name}:${major}`);
      run('oras', 'cp', reference, `ghcr.io/heey-global/verity/${name}:${major}.${minor}`);
    }
  }
  // Both architectures are checked before either mutable production tag moves.
  for (const architecture of ['amd64', 'arm64'] as const)
    run(
      'oras',
      'cp',
      candidate.envelopes[architecture],
      `ghcr.io/heey-global/verity/verity-server:channel-stable-${architecture}`,
    );
  process.env.TAG = `v${candidate.version}`;
  run('bash', 'scripts/finalize-server-production.sh');
  gh('workflow', 'run', 'release-dispatch.yml', '--ref', 'main', '-f', 'backend-replan=true');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'propose') propose();
  else if (process.argv[2] === 'promote') promote();
  else if (process.argv[2] === 'promote-native') await promoteNative();
  else throw new Error('Expected propose or promote');
}

export interface NativePromotion {
  schema: 1;
  product: 'mobile-native';
  version: string;
  source: string;
  appId: string;
  buildId: string;
  buildNumber: string;
  releasePr: number;
}
export function validateNativePromotion(value: unknown): NativePromotion {
  const candidate = value as NativePromotion;
  if (
    !candidate ||
    candidate.schema !== 1 ||
    candidate.product !== 'mobile-native' ||
    !/^\d+\.\d+\.0$/.test(candidate.version) ||
    !/^[a-f0-9]{40}$/.test(candidate.source) ||
    !/^\d+$/.test(candidate.appId) ||
    !/^[a-zA-Z0-9-]+$/.test(candidate.buildId) ||
    !/^\d+$/.test(candidate.buildNumber) ||
    !Number.isSafeInteger(candidate.releasePr) ||
    candidate.releasePr < 1
  )
    throw new Error('Invalid native production candidate');
  return candidate;
}
async function apple(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<{ data: Record<string, unknown> | Record<string, unknown>[] }> {
  const keyId = process.env.ASC_KEY_ID;
  const issuer = process.env.ASC_ISSUER_ID;
  const key = process.env.ASC_KEY_P8;
  if (!keyId || !issuer || !key) throw new Error('Missing App Store Connect API credentials');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
  ).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: createPrivateKey(key),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${input}.${signature}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      `App Store Connect ${method} ${path}: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as { data: Record<string, unknown> | Record<string, unknown>[] };
}
export async function promoteNative() {
  const path = 'releases/mobile-production.json';
  const candidate = validateNativePromotion(JSON.parse(readFileSync(path, 'utf8')));
  assertReviewed(path, 'automation/promote-mobile-production', candidate);
  assertRecorded(`mobile-v${candidate.version}`, candidate);
  if (candidate.appId !== process.env.ASC_APP_ID)
    throw new Error('Approved app differs from production ASC_APP_ID');
  const app = (await apple(`apps/${candidate.appId}`)).data as { attributes: { bundleId: string } };
  if (app.attributes.bundleId !== 'build.verity.app')
    throw new Error('Production app bundle identity differs');
  const build = (await apple(`builds/${candidate.buildId}`)).data as {
    attributes: { version: string; processingState: string };
  };
  if (
    build.attributes.version !== candidate.buildNumber ||
    build.attributes.processingState !== 'VALID'
  )
    throw new Error('Approved native build is not valid');
  const buildApp = (await apple(`builds/${candidate.buildId}/app`)).data as { id: string };
  const runtime = (await apple(`builds/${candidate.buildId}/preReleaseVersion`)).data as {
    attributes: { version: string; platform: string };
  };
  if (
    buildApp.id !== candidate.appId ||
    runtime.attributes.version !== candidate.version ||
    runtime.attributes.platform !== 'IOS'
  )
    throw new Error('Approved build belongs to a different app or runtime');
  const versions = (
    await apple(
      `apps/${candidate.appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${candidate.version}`,
    )
  ).data as {
    id: string;
    attributes: { appStoreState: string };
    relationships: { build: { data: { id: string } | null } };
  }[];
  if (versions.length > 1) throw new Error('Multiple App Store versions');
  let version = versions[0];
  if (!version)
    version = (
      await apple('appStoreVersions', 'POST', {
        data: {
          type: 'appStoreVersions',
          attributes: {
            platform: 'IOS',
            versionString: candidate.version,
            releaseType: 'AFTER_APPROVAL',
          },
          relationships: {
            app: { data: { type: 'apps', id: candidate.appId } },
            build: { data: { type: 'builds', id: candidate.buildId } },
          },
        },
      })
    ).data as typeof version;
  if (!version) throw new Error('App Store version was not created');
  const selected = (await apple(`appStoreVersions/${version.id}/build`)).data as {
    id: string;
  } | null;
  if (!selected) {
    await apple(`appStoreVersions/${version.id}/relationships/build`, 'PATCH', {
      data: { type: 'builds', id: candidate.buildId },
    });
  } else if (selected.id !== candidate.buildId)
    throw new Error('App Store version selects a different build; resolve it explicitly');
  const accepted = [
    'WAITING_FOR_REVIEW',
    'IN_REVIEW',
    'PENDING_APPLE_RELEASE',
    'PROCESSING_FOR_APP_STORE',
    'READY_FOR_SALE',
    'READY_FOR_DISTRIBUTION',
  ];
  if (!accepted.includes(version.attributes.appStoreState)) {
    const submissions = (
      await apple(
        `apps/${candidate.appId}/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`,
      )
    ).data as { id: string }[];
    if (submissions.length > 1) throw new Error('Multiple pending Apple review submissions');
    const submission =
      submissions[0] ??
      ((
        await apple('reviewSubmissions', 'POST', {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: candidate.appId } } },
          },
        })
      ).data as { id: string });
    const items = (await apple(`reviewSubmissions/${submission.id}/items`)).data as {
      relationships: { appStoreVersion?: { data: { id: string } } };
    }[];
    if (items.some((item) => item.relationships.appStoreVersion?.data.id !== version.id))
      throw new Error('Apple review submission includes unrelated items');
    if (!items.length)
      await apple('reviewSubmissionItems', 'POST', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
          },
        },
      });
    await apple(`reviewSubmissions/${submission.id}`, 'PATCH', {
      data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
    });
  }
  gh('release', 'edit', `mobile-v${candidate.version}`, '--prerelease=false', '--latest=false');
}
function assertReviewed(path: string, expectedBranch: string, candidate: unknown) {
  const repository = repo();
  const merge = run('git', 'log', '-1', '--format=%H', '--', path);
  const pulls = api<
    {
      number: number;
      merged_at: string | null;
      head: { ref: string; sha: string };
      base: { ref: string };
    }[]
  >(`repos/${repository}/commits/${merge}/pulls`);
  const pull = pulls.find(
    (p) => p.merged_at && p.head.ref === expectedBranch && p.base.ref === 'main',
  );
  if (!pull) throw new Error('Production requires a merged promotion PR');
  const reviews = api<{ state: string; commit_id: string }[]>(
    '--paginate',
    '--slurp',
    `repos/${repository}/pulls/${pull.number}/reviews?per_page=100`,
  ).flat();
  if (reviews.some((r) => r.state === 'APPROVED' && r.commit_id !== pull.head.sha))
    throw new Error('Stale candidate approval');
  const reviewed = api<{ content: string }>(
    `repos/${repository}/contents/${path}?ref=${pull.head.sha}`,
  );
  if (
    JSON.stringify(JSON.parse(Buffer.from(reviewed.content, 'base64').toString())) !==
    JSON.stringify(candidate)
  )
    throw new Error('Reviewed manifest differs');
  const checks = api<
    { check_runs: { id: number; name: string; conclusion: string; app: { slug: string } }[] }[]
  >(
    '--paginate',
    '--slurp',
    `repos/${repository}/commits/${pull.head.sha}/check-runs?per_page=100`,
  ).flatMap((page) => page.check_runs);
  if (
    checks
      .filter((c) => c.name === 'ci-checks' && c.app.slug === 'github-actions')
      .sort((a, b) => b.id - a.id)[0]?.conclusion !== 'success'
  )
    throw new Error('Exact promotion head has no successful CI');
}

export function assertPromotionOrder(
  current: { version: string; revision: string },
  candidate: { version: string; source: string },
): void {
  if (!/^\d+\.\d+\.\d+$/.test(current.version)) throw new Error('Invalid current stable version');
  const left = current.version.split('.').map(Number);
  const right = candidate.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i]! > right[i]!) throw new Error('Production promotion would roll back stable');
    if (left[i]! < right[i]!) return;
  }
  if (current.revision !== candidate.source)
    throw new Error('Production version already has another revision');
}

function assertRecorded(tag: string, candidate: unknown): void {
  const record = gh(
    'release',
    'download',
    tag,
    '--pattern',
    'production-candidate.json',
    '--output',
    '-',
  );
  if (JSON.stringify(JSON.parse(record)) !== JSON.stringify(candidate))
    throw new Error('Production approval differs from recorded release evidence');
}
