import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Candidate {
  schema: number;
  version: string;
  runtime: string;
  channel: string;
  commit: string;
  tag: string;
  branch: string;
  baseline: string;
  group?: string;
  notes?: string[];
}
type Artifact = Candidate & { group: string; notes: string[] };
interface Update {
  platform: string;
  branch: string;
  runtimeVersion: string;
  gitCommitHash: string;
  group: string;
  isRollBackToEmbedded?: boolean;
}
interface UpdateList {
  currentPage: { group: string }[];
}
interface Channel {
  currentPage: {
    name: string;
    isPaused?: boolean;
    branchMapping: string;
    updateBranches: { name: string; id: string }[];
  };
}
interface Mapping {
  version: number;
  data: { branchMappingLogic: string; branchId: string }[];
}
interface Release {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
}
interface Pull {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
}
interface AssociatedPull {
  number: number;
  merged_at: string | null;
  head: { ref: string; sha: string };
}
interface Review {
  id: number;
  state: string;
  commit_id: string;
}
interface CheckPage {
  check_runs: { id: number; name: string; conclusion: string; app: { slug: string } }[];
}
interface CommitResult {
  data: { createCommitOnBranch: { commit: { oid: string; signature: { isValid: boolean } } } };
}

const manifestPath = 'apps/mobile/ota-promotion.json';
/** Sources whose changes an OTA can carry; the manifest itself is mechanics. */
const sourcePaths = ['apps/mobile', 'packages/mobile', 'packages/events'];
const shaPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const uuidPattern = /^[0-9a-f-]{36}$/;

/** Plan from the delivered boundary, never from staged tags or abandoned PRs. */
export function planCandidate(
  nativeVersion: string,
  releasedVersion: string,
  commit: string,
  reservedVersions: string[] = [],
): Candidate {
  if (!versionPattern.test(nativeVersion) || !nativeVersion.endsWith('.0'))
    throw new Error('Invalid native runtime');
  if (!versionPattern.test(releasedVersion) || !shaPattern.test(commit))
    throw new Error('Invalid published version or source commit');
  const line = nativeVersion.split('.').slice(0, 2).join('.');
  if (!releasedVersion.startsWith(`${line}.`)) throw new Error('Published runtime changed');
  const patch = Math.max(
    Number(releasedVersion.split('.')[2]),
    ...reservedVersions
      .filter((value) => versionPattern.test(value) && value.startsWith(`${line}.`))
      .map((value) => Number(value.split('.')[2])),
  );
  const version = `${line}.${patch + 1}`;
  return {
    schema: 1,
    version,
    runtime: nativeVersion,
    channel: 'production',
    commit,
    tag: `mobile-v${version}`,
    branch: `staging-mobile-v${version}-${commit}`,
    baseline: `mobile-v${releasedVersion}`,
  };
}

/** A merged staging release owns its version even when production skips patches. */
export function fixedCandidate(
  runtime: string,
  baseline: string,
  commit: string,
  version: string,
): Candidate {
  if (
    !versionPattern.test(version) ||
    !version.startsWith(`${runtime.split('.').slice(0, 2).join('.')}.`)
  )
    throw new Error('Staging version must belong to the native runtime');
  const previous = `${version.split('.').slice(0, 2).join('.')}.${Number(version.split('.')[2]) - 1}`;
  const candidate = planCandidate(runtime, baseline, commit, [previous]);
  if (candidate.version !== version) throw new Error('Staging version must follow production');
  return candidate;
}

export function validateCandidate(input: unknown): Artifact {
  if (!input || typeof input !== 'object') throw new Error('Invalid candidate');
  const candidate = input as Artifact;
  const previousPatch = `${candidate.version?.split('.').slice(0, 2).join('.')}.${Number(candidate.version?.split('.')[2]) - 1}`;
  const planned = planCandidate(
    candidate.runtime,
    candidate.baseline?.replace(/^mobile-v/, ''),
    candidate.commit,
    [previousPatch],
  );
  if (candidate.channel === 'testflight') planned.channel = 'testflight';
  for (const key of Object.keys(planned) as (keyof Candidate)[]) {
    if (candidate[key] !== planned[key]) throw new Error(`Invalid candidate ${key}`);
  }
  if (
    !uuidPattern.test(candidate.group ?? '') ||
    !Array.isArray(candidate.notes) ||
    candidate.notes.some((note) => typeof note !== 'string' || !note.trim())
  )
    throw new Error('Candidate is missing immutable update evidence or release notes');
  return candidate;
}

/** EAS update:view --json returns one entry per platform, not the list summary. */
export function verifyUpdates(candidate: Candidate, updates: unknown): string {
  if (!Array.isArray(updates) || updates.length !== 1)
    throw new Error('Expected exactly one iOS update');
  const update = updates[0] as Update;
  if (
    update.platform !== 'ios' ||
    update.branch !== candidate.branch ||
    update.runtimeVersion !== candidate.runtime ||
    update.gitCommitHash !== candidate.commit ||
    !uuidPattern.test(update.group ?? '') ||
    (candidate.group && candidate.group !== update.group) ||
    update.isRollBackToEmbedded
  )
    throw new Error('EAS artifact does not match the approved candidate');
  return update.group;
}

export function singleGroup(list: UpdateList): string | undefined {
  if (!Array.isArray(list.currentPage)) throw new Error('Invalid EAS update list');
  if (list.currentPage.length > 1)
    throw new Error('Immutable candidate branch contains multiple update groups');
  const group = list.currentPage[0]?.group;
  if (group !== undefined && !uuidPattern.test(group)) throw new Error('Invalid EAS update group');
  return group;
}

export function verifyChannel(channel: Channel, branch: string, expectedChannel = 'production') {
  const value = channel.currentPage;
  const mapping = JSON.parse(value?.branchMapping ?? '{}') as Mapping;
  if (
    value?.name !== expectedChannel ||
    value.isPaused ||
    mapping.version !== 0 ||
    mapping.data?.length !== 1 ||
    mapping.data[0].branchMappingLogic !== 'true' ||
    !value.updateBranches?.some(
      (item) => item.name === branch && item.id === mapping.data[0].branchId,
    )
  )
    throw new Error('Update channel does not exclusively target the approved branch');
}

export function releaseNotes(subjects: string) {
  return [
    ...new Set(
      subjects
        .split('\n')
        .filter((subject) => /^(feat|fix|perf|revert)(\([^)]*\))?!?: /.test(subject)),
    ),
  ].map((subject) =>
    subject
      .replace(
        /^(feat|fix|perf|revert)(\([^)]*\))?(!)?: /,
        (_, _type: string, _scope: string, breaking: string) => (breaking ? 'Breaking: ' : ''),
      )
      .replace(/[\\`*_{}[\]<>]/g, (character) => `\\${character}`),
  );
}

function run(
  command: string,
  args: string[],
  options: Partial<ExecFileSyncOptionsWithStringEncoding> = {},
) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  }).trim();
}
const git = (...args: string[]) => run('git', args);
const gh = (...args: string[]) => run('gh', args);
const json = <T>(...args: string[]): T => JSON.parse(gh(...args)) as T;
const eas = (...args: string[]) =>
  run('npx', ['--yes', 'eas-cli@21.0.1', ...args], { cwd: 'apps/mobile' });
const easJson = <T>(...args: string[]): T => JSON.parse(eas(...args, '--json')) as T;
const repository = () => process.env.GITHUB_REPOSITORY;
const api = <T>(...args: string[]): T => json<T>('api', ...args);

function createPromotionCommit(...args: string[]): CommitResult {
  for (let attempt = 1; ; attempt++) {
    try {
      return JSON.parse(
        run('gh', ['api', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }),
      ) as CommitResult;
    } catch (error) {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      // Git push and GraphQL do not share a visibility boundary. Retry only
      // propagation, never a rejected expectedHeadOid or an unknown write result.
      if (!stderr.includes('Reference does not exist') || attempt === 6) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  }
}

function staleApprovals(number: number, head: string): Review[] {
  return api<Review[][]>(
    '--paginate',
    '--slurp',
    `repos/${repository()}/pulls/${number}/reviews?per_page=100`,
  )
    .flat()
    .filter((review) => review.state === 'APPROVED' && review.commit_id !== head);
}

function published(runtime: string) {
  const versions = releaseRows()
    .filter(
      (release) =>
        !release.draft && (!release.prerelease || release.tag_name === `mobile-v${runtime}`),
    )
    .map((release) => release.tag_name)
    .filter((tag) => /^mobile-v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const latest = versions.at(-1);
  if (!latest || !latest.startsWith(`mobile-v${runtime.split('.').slice(0, 2).join('.')}.`))
    throw new Error('Published native runtime changed; stage a new candidate');
  return latest;
}

function releaseRows(): Release[] {
  const rows = gh(
    'api',
    '--paginate',
    '--jq',
    '.[] | {tag_name, draft, prerelease}',
    `repos/${repository()}/releases?per_page=100`,
  );
  return rows
    .split('\n')
    .filter(Boolean)
    .map((row) => JSON.parse(row) as Release);
}

function reserve(tag: string, candidate: Candidate, target = candidate.commit) {
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (remote) {
    git('fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
    if (
      git('rev-list', '-n', '1', tag) !== target ||
      git('for-each-ref', '--format=%(contents)', `refs/tags/${tag}`) !== JSON.stringify(candidate)
    )
      throw new Error('Immutable candidate reservation changed');
    return false;
  }
  git(
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag',
    '-a',
    tag,
    target,
    '-m',
    JSON.stringify(candidate),
  );
  git('push', 'origin', `refs/tags/${tag}`);
  return true;
}

function readGroup(candidate: Candidate) {
  const group = singleGroup(
    easJson('update:list', '--branch', candidate.branch, '--limit', '2', '--non-interactive'),
  );
  if (group) verifyUpdates({ ...candidate, group }, easJson('update:view', group));
  return group;
}

/** Reconcile an interrupted upload before allowing another external write. */
export function stageArtifact(
  candidate: Candidate,
  io: {
    reserve: (candidate: Candidate) => void;
    ensureBranch: () => void;
    read: () => string | undefined;
    publish: () => void;
    claim: () => boolean;
  },
): string {
  io.reserve(candidate);
  io.ensureBranch();
  const existing = io.read();
  if (existing) return existing;
  if (!io.claim())
    throw new Error(
      'Upload was already attempted but EAS evidence is absent; reconcile it before retrying',
    );
  io.publish();
  const group = io.read();
  if (!group) throw new Error('EAS did not record the candidate; retry to reconcile publication');
  return group;
}

/**
 * A merge moves the approved boundary minutes before the promotion publishes
 * the release that `published()` reads. Staging inside that window plans the
 * version the merged candidate already owns, and its promotion would abort on
 * the public tag long after the manifest reached main. The merged manifest is
 * the earlier, authoritative boundary; read it from main, not from a checkout
 * that predates the merge.
 */
function compatibleBaseline(candidate: Candidate, delivered: string): boolean {
  if (delivered === candidate.baseline || delivered === candidate.tag) return true;
  const prefix = `mobile-v${candidate.runtime.split('.').slice(0, 2).join('.')}.`;
  if (!delivered.startsWith(prefix)) return false;
  const patch = Number(delivered.slice(prefix.length));
  return (
    Number.isInteger(patch) &&
    patch > Number(candidate.baseline.split('.').at(-1)) &&
    patch < Number(candidate.version.split('.').at(-1))
  );
}

function assertBaseline(candidate: Candidate) {
  const delivered = published(candidate.runtime);
  if (!compatibleBaseline(candidate, delivered))
    throw new Error('Published baseline changed; stage again');
  const approved = api<{ content: string }>(
    `repos/${repository()}/contents/${manifestPath}?ref=main`,
  );
  const merged = validateCandidate(JSON.parse(Buffer.from(approved.content, 'base64').toString()));
  const pending = merged.tag.localeCompare(delivered, 'en', { numeric: true }) > 0;
  if (pending && merged.tag.localeCompare(candidate.tag, 'en', { numeric: true }) >= 0)
    throw new Error('An approved promotion owns this version; stage a later version');
  return pending;
}

export function proposalBaseForSource(source: string, execute = git): string {
  execute('fetch', 'origin', 'main:refs/remotes/origin/main');
  const base = execute('rev-parse', 'origin/main');
  execute('merge-base', '--is-ancestor', source, base);
  return base;
}

function stage(runtime: string, version: string) {
  const stagingOAuth = process.env.STAGING_GOOGLE_AUTH_ID?.trim();
  if (!stagingOAuth || !/^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/.test(stagingOAuth))
    throw new Error('STAGING_GOOGLE_AUTH_ID must identify the Staging app OAuth client');

  const commit = process.env.OTA_SOURCE_SHA ?? process.env.GITHUB_SHA ?? '';
  if (git('rev-parse', 'HEAD') !== commit)
    throw new Error('Checkout differs from candidate source');
  const delivered = published(runtime);
  let candidate = fixedCandidate(runtime, delivered.replace(/^mobile-v/, ''), commit, version);
  const reservation = `ota-candidate/${candidate.tag}/${commit}`;
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${reservation}`)) {
    git('fetch', 'origin', `refs/tags/${reservation}:refs/tags/${reservation}`);
    const saved = JSON.parse(
      git('for-each-ref', '--format=%(contents)', `refs/tags/${reservation}`),
    ) as Candidate;
    const planned = fixedCandidate(
      runtime,
      saved.baseline.replace(/^mobile-v/, ''),
      commit,
      version,
    );
    if (JSON.stringify(saved) !== JSON.stringify(planned))
      throw new Error('Immutable candidate reservation changed');
    // Production can advance while a staging upload is interrupted. Keep its
    // original reservation so a retry reconciles the same bundle and evidence.
    candidate = planned;
  }
  assertBaseline(candidate);
  git('merge-base', '--is-ancestor', candidate.baseline, commit);
  const group = stageArtifact(candidate, {
    reserve: (value) => reserve(`ota-candidate/${value.tag}/${commit}`, value),
    ensureBranch: () => {
      // An existing branch is harmless; the subsequent read must succeed.
      try {
        eas('branch:create', candidate.branch, '--non-interactive');
      } catch {
        /* Verify existence with update:list before any upload. */
      }
    },
    read: () => readGroup(candidate),
    claim: () => reserve(`ota-upload/${candidate.tag}/${commit}`, candidate),
    publish: () => {
      run('node', ['scripts/stamp-mobile-build-info.mjs'], {
        env: { ...process.env, MOBILE_RELEASE_VERSION: candidate.version },
      });
      eas(
        'update',
        '--branch',
        candidate.branch,
        '--platform',
        'ios',
        '--message',
        `v${candidate.version} · ${commit}`,
        '--non-interactive',
        '--json',
      );
    },
  });
  // The separate app has a distinct runtime; its OTA cannot reach production.
  const stagingCandidate = {
    ...candidate,
    branch: `staging-${candidate.branch}`,
    runtime: `staging-${runtime}`,
  };
  try {
    eas('branch:create', stagingCandidate.branch, '--non-interactive');
  } catch {
    /* Read verifies existence. */
  }
  let stagingGroup = readGroup(stagingCandidate);
  if (!stagingGroup) {
    if (!reserve(`ota-staging-upload/${candidate.tag}/${commit}`, stagingCandidate))
      throw new Error(
        'Staging upload was attempted without recorded evidence; reconcile before retrying',
      );
    run(
      'npx',
      [
        '--yes',
        'eas-cli@21.0.1',
        'update',
        '--branch',
        stagingCandidate.branch,
        '--platform',
        'ios',
        '--message',
        `Staging ${candidate.version}`,
        '--non-interactive',
      ],
      {
        cwd: 'apps/mobile',
        env: {
          ...process.env,
          VERITY_APP_VARIANT: 'staging',
          EXPO_UPDATE_CHANNEL: 'staging',
          GOOGLE_AUTH_ID: stagingOAuth,
        },
      },
    );
    stagingGroup = readGroup(stagingCandidate);
    if (!stagingGroup) throw new Error('Staging OTA evidence is missing');
  }
  eas('channel:edit', 'staging', '--branch', stagingCandidate.branch, '--non-interactive');
  verifyChannel(
    easJson('channel:view', 'staging', '--non-interactive'),
    stagingCandidate.branch,
    'staging',
  );
  candidate.group = group;
  candidate.notes = releaseNotes(
    git('log', '--format=%s', `${candidate.baseline}..${commit}`, '--', ...sourcePaths),
  );
  reserve(`ota-artifact/${candidate.tag}/${commit}`, candidate);
  assertBaseline(candidate);
  const publicTag = git('ls-remote', '--tags', 'origin', `refs/tags/${candidate.tag}`);
  if (publicTag) {
    git('fetch', 'origin', `refs/tags/${candidate.tag}:refs/tags/${candidate.tag}`);
    if (git('rev-list', '-n', '1', candidate.tag) !== commit)
      throw new Error('Staging release version already has another source');
  } else {
    git('tag', candidate.tag, commit);
    git('push', 'origin', `refs/tags/${candidate.tag}`);
  }
  finishRelease(candidate, true);
  if (published(runtime) === candidate.tag) return;

  // Delivery reads the merged approval, while the rolling branch remains its
  // audit evidence. Publish Staging now and refresh the proposal after delivery.
  if (assertBaseline(candidate)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'deferred=true\n');
    console.log('Staging published; Production proposal waits for approved delivery');
    return;
  }

  const proposalBase = proposalBaseForSource(candidate.commit);
  const branch = `automation/promote-mobile-ota-${runtime}`;
  const open = json<Pull[]>(
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,headRefOid,author',
  );
  if (
    open.length > 1 ||
    (open[0] &&
      open[0].author?.login !== 'app/github-actions' &&
      open[0].author?.login !== 'github-actions[bot]')
  )
    throw new Error('Rolling OTA branch is not exclusively workflow-owned');
  const expectedHead = open[0]?.headRefOid ?? git('rev-parse', commit);
  if (open[0]) {
    git('fetch', 'origin', branch);
    // A prior run can stop after resetting this branch to the source but before
    // GraphQL creates its metadata commit. That source may have no manifest (or
    // an older schema). Only the immutable artifact record authorizes recovery.
    let interruptedRecord = `ota-proposal-base/${candidate.tag}/${expectedHead}`;
    let recorded = git('for-each-ref', '--format=%(contents)', `refs/tags/${interruptedRecord}`);
    if (!recorded) {
      interruptedRecord = `ota-artifact/${candidate.tag}/${expectedHead}`;
      recorded = git('for-each-ref', '--format=%(contents)', `refs/tags/${interruptedRecord}`);
    }
    const previous = validateCandidate(
      JSON.parse(recorded || git('show', `FETCH_HEAD:${manifestPath}`)),
    );
    if (
      recorded &&
      (previous.runtime !== runtime ||
        git('rev-list', '-n', '1', interruptedRecord) !== expectedHead)
    )
      throw new Error('Interrupted rolling reset does not match its immutable artifact');
    git('merge-base', '--is-ancestor', previous.commit, commit);
    if (recorded) git('merge-base', '--is-ancestor', previous.commit, expectedHead);
  }
  // The proposal changes only metadata on current main; mobile CI checks the
  // immutable artifact source explicitly instead of this proposal base.
  const remote = git('ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0];
  const ownerTag = `ota-rolling/${runtime}`;
  const ownerRecord = git('for-each-ref', '--format=%(contents)', `refs/tags/${ownerTag}`);
  if (remote && !open[0]) {
    const historical = json<Pull[]>(
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'author',
    );
    if (
      historical.some(
        (pr) => !['app/github-actions', 'github-actions[bot]'].includes(pr.author?.login),
      )
    )
      throw new Error('Refusing to replace an unowned rolling branch');
    if (!historical.length) {
      // A branch can exist before its first PR. The ownership reservation must
      // predate that write; namespace or matching source alone grants no authority.
      if (!ownerRecord) throw new Error('Refusing to replace an unowned rolling branch');
      const owner = validateCandidate(JSON.parse(ownerRecord));
      if (owner.runtime !== runtime || git('rev-list', '-n', '1', ownerTag) !== owner.commit)
        throw new Error('Invalid rolling branch ownership reservation');
      git('merge-base', '--is-ancestor', owner.commit, commit);
      git('fetch', 'origin', branch);
      let baseTag = `ota-proposal-base/${candidate.tag}/${remote}`;
      let sourceRecord = git('for-each-ref', '--format=%(contents)', `refs/tags/${baseTag}`);
      if (!sourceRecord) {
        baseTag = `ota-artifact/${candidate.tag}/${remote}`;
        sourceRecord = git('for-each-ref', '--format=%(contents)', `refs/tags/${baseTag}`);
      }
      const previous = validateCandidate(
        JSON.parse(sourceRecord || git('show', `FETCH_HEAD:${manifestPath}`)),
      );
      const artifactTag = `ota-artifact/${previous.tag}/${previous.commit}`;
      if (
        previous.runtime !== runtime ||
        git('for-each-ref', '--format=%(contents)', `refs/tags/${artifactTag}`) !==
          JSON.stringify(previous) ||
        git('rev-list', '-n', '1', artifactTag) !== previous.commit
      )
        throw new Error('Orphaned rolling branch has no matching immutable artifact');
      git('merge-base', '--is-ancestor', previous.commit, commit);
      if (sourceRecord) {
        if (git('rev-list', '-n', '1', baseTag) !== remote)
          throw new Error('Orphaned rolling source differs from its reservation');
        git('merge-base', '--is-ancestor', previous.commit, remote);
      } else {
        git('merge-base', '--is-ancestor', previous.commit, remote);
        const parents = git('rev-list', '--parents', '-n', '1', remote).split(' ');
        const metadata = api<{ verification: { verified: boolean } }>(
          `repos/${repository()}/git/commits/${remote}`,
        );
        if (
          parents.length !== 2 ||
          !metadata.verification.verified ||
          git('diff', '--name-only', parents[1], remote) !== manifestPath
        )
          throw new Error(
            'Orphaned rolling metadata commit is not a verified candidate-only change',
          );
      }
    }
  }
  if (!remote && !ownerRecord) reserve(ownerTag, candidate);
  if (open[0] && remote !== expectedHead) throw new Error('Rolling PR changed during staging');
  if (assertBaseline(candidate)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'deferred=true\n');
    return;
  }
  reserve(`ota-proposal-base/${candidate.tag}/${proposalBase}`, candidate, proposalBase);
  git(
    'push',
    `--force-with-lease=refs/heads/${branch}:${remote}`,
    'origin',
    `${proposalBase}:refs/heads/${branch}`,
  );
  const contents = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`).toString('base64');
  const query =
    'mutation($repository: String!, $branch: String!, $expected: GitObjectID!, $message: String!, $path: String!, $contents: Base64String!) { createCommitOnBranch(input: { branch: { repositoryNameWithOwner: $repository, branchName: $branch }, expectedHeadOid: $expected, message: { headline: $message }, fileChanges: { additions: [{path: $path, contents: $contents}] } }) { commit { oid signature { isValid } } } }';
  const result = createPromotionCommit(
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `repository=${repository()}`,
    '-f',
    `branch=${branch}`,
    '-f',
    `expected=${proposalBase}`,
    '-f',
    `message=chore(release): production mobile OTA ${candidate.version}`,
    '-f',
    `path=${manifestPath}`,
    '-f',
    `contents=${contents}`,
  );
  if (!result.data.createCommitOnBranch.commit.signature.isValid)
    throw new Error('Promotion commit is not verified');
  const title = `chore(release): production mobile OTA ${candidate.version}`;
  const body = `Promotes immutable EAS update group \`${group}\` for runtime \`${runtime}\`.\n\nSource: \`${commit}\`\nPublished baseline: \`${candidate.baseline}\`\n\nChanges since the delivered release:\n${candidate.notes.map((note) => `- ${note}`).join('\n') || '- Mobile application updates.'}\n\nMerging approves this exact candidate. CI validates the current PR head; an older approval cannot select an older bundle.\n`;
  const bodyFile = `${process.env.RUNNER_TEMP}/mobile-ota-pr.md`;
  writeFileSync(bodyFile, body);
  let number = open[0]?.number;
  if (number)
    gh(
      'pr',
      'edit',
      String(number),
      '--title',
      title,
      '--body-file',
      bodyFile,
      '--add-label',
      'production',
    );
  else
    number = Number(
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
      )
        .split('/')
        .at(-1),
    );
  // The new commit has no CI verdict yet. Clear approvals for earlier candidates
  // before starting CI so stale approval cannot make this candidate mergeable.
  for (const review of staleApprovals(number, result.data.createCommitOnBranch.commit.oid)) {
    gh(
      'api',
      '--method',
      'PUT',
      `repos/${repository()}/pulls/${number}/reviews/${review.id}/dismissals`,
      '-f',
      'message=The OTA candidate changed. Review the current immutable update before approving again.',
    );
  }
  gh(
    'workflow',
    'run',
    'ci.yml',
    '--ref',
    branch,
    '-f',
    'release-train=mobile-ota',
    '-f',
    `release-pr=${number}`,
  );
  // Retire only known workflow-authored legacy candidates after the rolling PR
  // and its verification exist; never close human-authored work by title alone.
  const others = json<Pull[]>(
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '100',
    '--json',
    'number,headRefName,author',
  );
  const legacyPrefix = `automation/promote-mobile-v${runtime.split('.').slice(0, 2).join('.')}.`;
  for (const pr of others) {
    if (
      !pr.headRefName.startsWith(legacyPrefix) ||
      !/^automation\/promote-mobile-v\d+\.\d+\.\d+$/.test(pr.headRefName) ||
      !['app/github-actions', 'github-actions[bot]'].includes(pr.author?.login)
    )
      continue;
    const legacyFile = api<{ content: string }>(
      `repos/${repository()}/contents/${manifestPath}?ref=${pr.headRefName}`,
    );
    const legacy = JSON.parse(Buffer.from(legacyFile.content, 'base64').toString()) as {
      commit?: string;
    };
    if (!legacy.commit || !shaPattern.test(legacy.commit)) continue;
    try {
      git('merge-base', '--is-ancestor', legacy.commit, candidate.commit);
    } catch {
      continue;
    }
    gh('pr', 'close', String(pr.number));
  }
  // An approval can merge after the last check. Keep recovery durable even
  // when the proposal was written against a main tip that has since moved.
  git('fetch', 'origin', 'main:refs/remotes/origin/main');
  if (git('rev-parse', 'origin/main') !== proposalBase || assertBaseline(candidate)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'deferred=true\n');
    gh('workflow', 'run', 'mobile-ota.yml', '--ref', 'main');
  }
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY ?? '/dev/null',
    `OTA ${candidate.version} staged as ${group}; rolling PR #${number}.\n`,
  );
}

function promote() {
  const candidate = validateCandidate(JSON.parse(readFileSync(manifestPath, 'utf8')));
  git('merge-base', '--is-ancestor', candidate.commit, 'HEAD');
  const record = `ota-artifact/${candidate.tag}/${candidate.commit}`;
  if (
    git('for-each-ref', '--format=%(contents)', `refs/tags/${record}`) !== JSON.stringify(candidate)
  )
    throw new Error('Approved manifest differs from immutable artifact record');
  // The manifest must be exactly the content whose PR head passed CI, including
  // manual retries. Do not rely on repository approval-dismissal settings.
  const mergeCommit = git('log', '-1', '--format=%H', '--', manifestPath);
  const prs = api<AssociatedPull[]>(`repos/${repository()}/commits/${mergeCommit}/pulls`);
  const pr = prs.find(
    (value) =>
      value.merged_at && value.head.ref === `automation/promote-mobile-ota-${candidate.runtime}`,
  );
  if (!pr) throw new Error('Promotion requires a merged rolling candidate PR');
  if (staleApprovals(pr.number, pr.head.sha).length)
    throw new Error(
      'A prior candidate approval is still active; the merged candidate requires a fresh review',
    );
  const checkedManifest = api<{ content: string }>(
    `repos/${repository()}/contents/${manifestPath}?ref=${pr.head.sha}`,
  );
  if (
    JSON.stringify(JSON.parse(Buffer.from(checkedManifest.content, 'base64').toString())) !==
    JSON.stringify(candidate)
  )
    throw new Error('Merged manifest differs from the reviewed candidate');
  const checks = api<CheckPage[]>(
    '--paginate',
    '--slurp',
    `repos/${repository()}/commits/${pr.head.sha}/check-runs?per_page=100`,
  ).flatMap((page) => page.check_runs);
  const verdict = checks
    .filter((check) => check.name === 'ci-checks' && check.app?.slug === 'github-actions')
    .sort((a, b) => b.id - a.id)[0];
  if (verdict?.conclusion !== 'success')
    throw new Error('The exact candidate PR head has no successful CI verdict');
  const native = releaseRows().find(
    (release) => release.tag_name === `mobile-v${candidate.runtime}` && !release.draft,
  );
  if (!native || native.prerelease)
    throw new Error('Approve the native production runtime before promoting its OTA');
  const latest = published(candidate.runtime);
  if (!compatibleBaseline(candidate, latest))
    throw new Error('Candidate is stale; stage against the delivered release');
  if (readGroup(candidate) !== candidate.group)
    throw new Error('Candidate branch no longer holds the approved group');
  const remoteTag = git('ls-remote', '--tags', 'origin', `refs/tags/${candidate.tag}`);
  if (remoteTag) {
    git('fetch', 'origin', `refs/tags/${candidate.tag}:refs/tags/${candidate.tag}`);
    if (git('rev-list', '-n', '1', candidate.tag) !== candidate.commit)
      throw new Error('Public release tag already has another source');
  } else {
    git('tag', candidate.tag, candidate.commit);
    git('push', 'origin', `refs/tags/${candidate.tag}`);
  }
  eas('channel:edit', candidate.channel, '--branch', candidate.branch, '--non-interactive');
  verifyChannel(
    easJson('channel:view', candidate.channel, '--non-interactive'),
    candidate.branch,
    candidate.channel,
  );
  if (latest !== candidate.tag) finishRelease(candidate);
  restage(candidate);
}

/**
 * Delivery strands every candidate staged after this one was approved: its
 * baseline is now the previous release, so its own promotion could only abort.
 * The promotion commit is the sole push that follows, and staging skips it by
 * design, so nothing on main re-triggers staging. Ask for it explicitly, after
 * the release exists — a restage started earlier would plan this version again.
 */
function restage(candidate: Artifact) {
  git('fetch', 'origin', 'main:refs/remotes/origin/main');
  const pending = releaseNotes(
    git('log', '--format=%s', `${candidate.commit}..origin/main`, '--', ...sourcePaths),
  );
  if (pending.length) gh('workflow', 'run', 'mobile-ota.yml', '--ref', 'main');
}

function finishRelease(candidate: Artifact, staging = false) {
  const notesFile = `${process.env.RUNNER_TEMP}/mobile-ota-release.md`;
  writeFileSync(
    notesFile,
    `${candidate.notes.map((note) => `- ${note}`).join('\n')}\n\nEAS group: ${candidate.group}\nSource: ${candidate.commit}\nRuntime: ${candidate.runtime}\n`,
  );
  const releases = releaseRows();
  // Creating a published prerelease is atomic. Editing an existing release
  // could race with Production delivery and demote it back to Staging.
  if (staging) {
    const existing = releases.find((release) => release.tag_name === candidate.tag);
    if (existing?.draft)
      throw new Error('Existing OTA draft requires reconciliation before Staging can complete');
    if (!existing)
      gh(
        'release',
        'create',
        candidate.tag,
        '--prerelease',
        '--title',
        `Mobile ${candidate.version} (OTA)`,
        '--notes-file',
        notesFile,
        '--latest=false',
      );
    return;
  }
  if (!releases.some((release) => release.tag_name === candidate.tag))
    gh(
      'release',
      'create',
      candidate.tag,
      '--draft',
      '--title',
      `Mobile ${candidate.version} (OTA)`,
      '--notes-file',
      notesFile,
      '--latest=false',
    );
  gh(
    'release',
    'edit',
    candidate.tag,
    '--draft=false',
    `--prerelease=${staging}`,
    '--notes-file',
    notesFile,
    '--latest=false',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'stage') stage(process.argv[3] ?? '', process.argv[4] ?? '');
  else if (process.argv[2] === 'promote') promote();
  else throw new Error('Usage: mobile-ota-release.ts stage <runtime> <version> | promote');
}
