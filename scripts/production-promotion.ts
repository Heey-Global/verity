import { captureJson } from './capture-json.mjs';
import { promotionChangelog, type PromotionRelease } from './promotion-changelog.mjs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, createWriteStream, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

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

const nativeEvidenceBranch = 'automation/mobile-production-evidence';
const nativeEvidencePath = (version: string) => `releases/native-production/${version}.json`;

function optionalApi<T>(endpoint: string): T | undefined {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', endpoint], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as T;
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr?.toString();
    if (stderr && /HTTP 404/.test(stderr)) return undefined;
    throw error;
  }
}
function readNativeEvidence(version: string) {
  return optionalApi<{ content: string; sha: string }>(
    `repos/${repo()}/contents/${nativeEvidencePath(version)}?ref=${nativeEvidenceBranch}`,
  );
}
function writeNativeEvidence(candidate: NativePromotion, previousSha?: string) {
  const repository = repo();
  if (!optionalApi(`repos/${repository}/git/ref/heads/${nativeEvidenceBranch}`)) {
    const main = api<{ object: { sha: string } }>(`repos/${repository}/git/ref/heads/main`);
    api(
      `repos/${repository}/git/refs`,
      '--method',
      'POST',
      '-f',
      `ref=refs/heads/${nativeEvidenceBranch}`,
      '-f',
      `sha=${main.object.sha}`,
    );
  }
  // The file SHA makes a concurrent replacement fail instead of overwriting evidence.
  api(
    `repos/${repository}/contents/${nativeEvidencePath(candidate.version)}`,
    '--method',
    'PUT',
    '-f',
    `branch=${nativeEvidenceBranch}`,
    '-f',
    `message=chore(release): record native production ${candidate.version}`,
    '-f',
    `content=${Buffer.from(JSON.stringify(candidate, null, 2) + '\n').toString('base64')}`,
    ...(previousSha ? ['-f', `sha=${previousSha}`] : []),
  );
}

function nativeArtifactExpired(id: number): boolean {
  try {
    const metadata = JSON.parse(
      execFileSync('gh', ['api', `repos/${repo()}/actions/artifacts/${id}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    ) as { expired: boolean };
    if (typeof metadata.expired !== 'boolean')
      throw new Error('Invalid artifact availability response');
    return metadata.expired;
  } catch (error) {
    // GitHub deletes archives after their retention window; other API failures
    // must not silently authorize replacing an existing candidate.
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    if (stderr && /HTTP 404/.test(typeof stderr === 'string' ? stderr : stderr.toString('utf8')))
      return true;
    throw error;
  }
}

export function propose(inputPath = process.argv[3] ?? '') {
  const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as { product?: string };
  let candidate =
    raw.product === 'mobile-native' ? validateNativePromotion(raw) : validateServerPromotion(raw);
  const manifest =
    candidate.product === 'server'
      ? 'releases/server-production.json'
      : 'releases/mobile-production.json';
  const branch =
    candidate.product === 'server'
      ? 'automation/promote-server-production'
      : 'automation/promote-mobile-production';
  const product = candidate.product === 'server' ? 'server' : 'mobile native';
  const tag =
    candidate.product === 'server' ? `v${candidate.version}` : `mobile-v${candidate.version}`;
  const recordPath = `${process.env.RUNNER_TEMP ?? '/tmp'}/production-candidate.json`;
  const release = JSON.parse(gh('release', 'view', tag, '--json', 'assets,isPrerelease')) as {
    assets: { name: string }[];
    isPrerelease: boolean;
  };
  const evidence =
    candidate.product === 'mobile-native' ? readNativeEvidence(candidate.version) : undefined;
  let needsNativeRecord = candidate.product === 'mobile-native' && !evidence;
  if (evidence || release.assets.some((asset) => asset.name === 'production-candidate.json')) {
    const recorded = evidence
      ? Buffer.from(evidence.content, 'base64').toString('utf8')
      : gh('release', 'download', tag, '--pattern', 'production-candidate.json', '--output', '-');
    const previous = JSON.parse(recorded) as ServerPromotion | NativePromotion;
    if (JSON.stringify(previous) !== JSON.stringify(candidate)) {
      if (candidate.product !== 'mobile-native' || previous.product !== 'mobile-native')
        throw new Error('Release candidate already has different production evidence');
      validateNativePromotion(previous);
      const incoming = candidate;
      if (
        ['version', 'source', 'appId', 'releasePr'].some(
          (field) =>
            previous[field as keyof NativePromotion] !== incoming[field as keyof NativePromotion],
        )
      )
        throw new Error('Replacement archive differs from the immutable native release');
      if (previous.schema === 1 || !nativeArtifactExpired(previous.artifact!.id)) {
        // A normal retry must preserve bytes that may already have been reviewed.
        candidate = previous;
      } else {
        if (!release.isPrerelease)
          throw new Error('Cannot replace an already published production release');
        if (candidate.schema !== 2 || nativeArtifactExpired(candidate.artifact!.id))
          throw new Error('Replacement archive is unavailable');
        // Recorded evidence changes first: old merged approvals cannot upload it.
        writeFileSync(recordPath, JSON.stringify(candidate, null, 2) + '\n');
        needsNativeRecord = true;
      }
    }
  } else {
    writeFileSync(recordPath, JSON.stringify(candidate, null, 2) + '\n');
    if (candidate.product === 'server') gh('release', 'upload', tag, recordPath);
  }

  if (needsNativeRecord && candidate.product === 'mobile-native')
    writeNativeEvidence(candidate, evidence?.sha);

  const repository = repo();
  const approvals = JSON.parse(
    gh(
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'merged',
      '--json',
      'number,headRefOid,author,baseRefName',
    ),
  ) as { number: number; headRefOid: string; author: { login: string }; baseRefName: string }[];
  for (const approval of approvals) {
    if (
      approval.baseRefName !== 'main' ||
      !['app/github-actions', 'github-actions[bot]'].includes(approval.author.login)
    )
      continue;
    const record = api<{ content: string }>(
      `repos/${repository}/contents/${manifest}?ref=${approval.headRefOid}`,
    );
    if (
      JSON.stringify(JSON.parse(Buffer.from(record.content, 'base64').toString('utf8'))) ===
      JSON.stringify(candidate)
    )
      return;
  }
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
  if (existing) {
    const previous = JSON.parse(existing) as { version: string; source: string };
    // A delayed finalizer must not replace a newer candidate awaiting approval.
    assertPromotionOrder({ version: previous.version, revision: previous.source }, candidate);
  }
  const sameCandidate =
    existing && JSON.stringify(JSON.parse(existing)) === JSON.stringify(candidate);
  if (!sameCandidate) {
    if (remote) {
      // New candidates must run CI on current main; retries keep their exact head.
      run(
        'git',
        'push',
        `--force-with-lease=refs/heads/${branch}:${head}`,
        'origin',
        `${main}:refs/heads/${branch}`,
      );
      head = main;
    }
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
      `message=chore(release): production ${product} ${candidate.version}`,
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
  const title = `chore(release): production ${product} ${candidate.version}`;
  const releases = (
    captureJson('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repository}/releases?per_page=100`,
    ]) as PromotionRelease[][]
  ).flat();
  const changelog = promotionChangelog(releases, candidate.product, candidate.version);
  const bodyFile = `${process.env.RUNNER_TEMP ?? '/tmp'}/server-production-pr.md`;
  writeFileSync(
    bodyFile,
    `Promotes the verified Staging candidate ${candidate.version} to production.\n\nSource: ${candidate.source}\n\n${changelog}\n\nMerging approves the exact recorded artifacts in ${manifest}. Test Staging before merging. The release remains a prerelease until production publication finishes.\n`,
  );
  if (pulls.length)
    gh(
      'pr',
      'edit',
      String(pulls[0]!.number),
      '--title',
      title,
      '--body-file',
      bodyFile,
      '--add-label',
      'production',
    );
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
      '--label',
      'production',
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
    if (name === 'verity-sandbox')
      run('oras', 'cp', reference, 'ghcr.io/heey-global/verity-sandbox:latest');
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
  schema: 1 | 2;
  artifact?: { id: number; sha256: string };
  product: 'mobile-native';
  version: string;
  source: string;
  appId: string;
  buildId?: string;
  buildNumber: string;
  releasePr: number;
}
export function validateNativePromotion(value: unknown): NativePromotion {
  const candidate = value as NativePromotion;
  if (
    !candidate ||
    ![1, 2].includes(candidate.schema) ||
    candidate.product !== 'mobile-native' ||
    !/^\d+\.\d+\.0$/.test(candidate.version) ||
    !/^[a-f0-9]{40}$/.test(candidate.source) ||
    !/^\d+$/.test(candidate.appId) ||
    (candidate.schema === 1
      ? !/^[a-zA-Z0-9-]+$/.test(candidate.buildId ?? '')
      : !Number.isSafeInteger(candidate.artifact?.id) ||
        (candidate.artifact?.id ?? 0) < 1 ||
        !/^[a-f0-9]{64}$/.test(candidate.artifact?.sha256 ?? '')) ||
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
  const content = await response.text();
  return (content.trim() ? JSON.parse(content) : { data: {} }) as {
    data: Record<string, unknown> | Record<string, unknown>[];
  };
}
export function assertTestFlightReady(state: string): void {
  if (state !== 'IN_BETA_TESTING')
    throw new Error(`Approved build is not available for internal TestFlight testing (${state})`);
}
async function uploadApprovedBinary(candidate: NativePromotion): Promise<string> {
  const artifact = candidate.artifact!;
  const metadata = api<{ expired: boolean; archive_download_url: string }>(
    `repos/${repo()}/actions/artifacts/${artifact.id}`,
  );
  if (metadata.expired)
    throw new Error('Approved binary expired; prepare and approve a new candidate');
  const root = mkdtempSync(`${process.env.RUNNER_TEMP ?? '/tmp'}/approved-native-`);
  const response = await fetch(metadata.archive_download_url, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` },
  });
  if (!response.ok || !response.body) throw new Error('Cannot download approved binary');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${root}/archive.zip`));
  run('ditto', '-x', '-k', `${root}/archive.zip`, root);
  const ipa = `${root}/Verity.ipa`;
  if (createHash('sha256').update(readFileSync(ipa)).digest('hex') !== artifact.sha256)
    throw new Error('Stored binary differs from approved digest');
  const keyDirectory = `${process.env.HOME}/.appstoreconnect/private_keys`;
  mkdirSync(keyDirectory, { recursive: true });
  writeFileSync(`${keyDirectory}/AuthKey_${process.env.ASC_KEY_ID}.p8`, process.env.ASC_KEY_P8!, {
    mode: 0o600,
  });
  const existing = (
    await apple(
      `builds?filter[app]=${candidate.appId}&filter[version]=${candidate.buildNumber}&filter[preReleaseVersion.version]=${candidate.version}`,
    )
  ).data as { id: string }[];
  if (existing.length > 1) throw new Error('Multiple builds match approved binary');
  if (existing.length === 0)
    run(
      'xcrun',
      'altool',
      '--upload-app',
      '--type',
      'ios',
      '--file',
      ipa,
      '--apiKey',
      process.env.ASC_KEY_ID!,
      '--apiIssuer',
      process.env.ASC_ISSUER_ID!,
    );
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await apple(
      `builds?filter[app]=${candidate.appId}&filter[version]=${candidate.buildNumber}&filter[preReleaseVersion.version]=${candidate.version}`,
    );
    const builds = result.data as { id: string; attributes: { processingState: string } }[];
    if (builds.length > 1) throw new Error('Multiple builds match approved binary');
    const build = builds[0];
    if (build?.attributes.processingState === 'VALID') return build.id;
    if (build && ['FAILED', 'INVALID'].includes(build.attributes.processingState))
      throw new Error('Apple rejected approved binary');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new Error('Apple processing timed out');
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
  const buildId =
    candidate.schema === 2 ? await uploadApprovedBinary(candidate) : candidate.buildId!;
  const build = (await apple(`builds/${buildId}`)).data as {
    attributes: { version: string; processingState: string };
  };
  if (
    build.attributes.version !== candidate.buildNumber ||
    build.attributes.processingState !== 'VALID'
  )
    throw new Error('Approved native build is not valid');
  const buildApp = (await apple(`builds/${buildId}/app`)).data as { id: string };
  const runtime = (await apple(`builds/${buildId}/preReleaseVersion`)).data as {
    attributes: { version: string; platform: string };
  };
  if (
    buildApp.id !== candidate.appId ||
    runtime.attributes.version !== candidate.version ||
    runtime.attributes.platform !== 'IOS'
  )
    throw new Error('Approved build belongs to a different app or runtime');
  // Uploading to TestFlight already distributes builds according to Apple's group settings.
  // Promotion must not create an App Store version or submit the app for review.
  for (let attempt = 0; ; attempt++) {
    const details = (await apple(`builds/${buildId}/buildBetaDetail`)).data as {
      attributes: { internalBuildState: string };
    };
    const state = details.attributes.internalBuildState;
    if (state === 'IN_BETA_TESTING') break;
    // Apple can finish binary processing before internal TestFlight distribution.
    if (
      candidate.schema !== 2 ||
      attempt >= 59 ||
      !['PROCESSING', 'READY_FOR_BETA_TESTING'].includes(state)
    )
      assertTestFlightReady(state);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
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

function assertRecorded(tag: string, candidate: ServerPromotion | NativePromotion): void {
  // A quickly merged approval must not race the finalizer's draft publication.
  if (gh('release', 'view', tag, '--json', 'isDraft', '--jq', '.isDraft').trim() !== 'false')
    throw new Error('Staging finalization is not complete; retry promotion after publication');

  const evidence =
    candidate.product === 'mobile-native' ? readNativeEvidence(candidate.version) : undefined;
  const record = evidence
    ? Buffer.from(evidence.content, 'base64').toString('utf8')
    : gh('release', 'download', tag, '--pattern', 'production-candidate.json', '--output', '-');
  if (JSON.stringify(JSON.parse(record)) !== JSON.stringify(candidate))
    throw new Error('Production approval differs from recorded release evidence');
}
