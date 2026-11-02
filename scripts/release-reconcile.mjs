#!/usr/bin/env node
// Missed-event backstop for release publication; see release-reconcile.yml.
// Publication is event-driven, and a push event GitHub never delivered leaves
// a merged release PR or an approved promotion candidate with no run at all. This
// script detects those and dispatches the ordinary workflows. It publishes
// nothing itself, and it reports states that need a human as errors instead
// of retrying them every sweep.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { nativePathKind } from './mobile-native-compatibility.mjs';
import { pendingReleasePrs } from './pending-release-prs.mjs';
import { isReleaseBotLogin } from './release-bot-logins.mjs';
import { promotionIdentity, parseRecoveryReceipt } from './promotion-recovery.mjs';

const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('GITHUB_REPOSITORY is required');

/** @type {Record<string, {component: string, manifest: string, path: string, prefix: string}>} */
const trains = {
  backend: {
    component: 'server',
    manifest: '.release-please-manifest.backend.json',
    path: '.',
    prefix: 'v',
  },
  mobile: {
    component: 'mobile',
    manifest: '.release-please-manifest.mobile.json',
    path: 'apps/mobile',
    prefix: 'mobile-v',
  },
  website: {
    component: 'website',
    manifest: '.release-please-manifest.website.json',
    path: 'docs/website',
    prefix: 'website-v',
  },
};
const otaManifest = 'apps/mobile/ota-promotion.json';
const releaseWorkflow = 'release-dispatch.yml';
const promoteWorkflow = 'mobile-ota-promote.yml';
const nativePromoteWorkflow = 'mobile-production-promote.yml';
const otaWorkflow = 'mobile-ota.yml';
/** The `run-name` release-dispatch.yml gives a reconcile run and nothing else. */
const reconcileRunTitle = 'Reconcile unpublished releases';
/**
 * GitHub creates the push run for a merge some time after the merge, minutes
 * under load. A merge younger than this is still the push run's to publish;
 * dispatching against it would only race that run for the train lock.
 */
const graceMs = 10 * 60 * 1000;
/**
 * Planning a Staging release PR is safe to repeat: a late push run that plans
 * after this sweep's dispatch refreshes the same PR with the same content. Only
 * publication races a late push run into a red, refused tag, so planning waits
 * just long enough for an ordinary push run to appear.
 */
const planningGraceMs = 2 * 60 * 1000;
const now = Date.now();

/** @param {string[]} args */
const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** @returns {{tag_name: string, draft: boolean, prerelease: boolean, published_at: string | null}[]} */
function releases() {
  // Paginate: a release missing from page one must never look unpublished.
  return gh(
    'api',
    '--paginate',
    '--jq',
    '.[] | {tag_name, draft, prerelease, published_at}',
    `repos/${repository}/releases?per_page=100`,
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const release = /** @type {unknown} */ (JSON.parse(line));
      if (
        typeof release !== 'object' ||
        release === null ||
        !('tag_name' in release) ||
        typeof release.tag_name !== 'string' ||
        !('draft' in release) ||
        typeof release.draft !== 'boolean' ||
        !('prerelease' in release) ||
        typeof release.prerelease !== 'boolean'
      )
        throw new Error('Invalid release metadata');
      const publishedAt =
        'published_at' in release && typeof release.published_at === 'string'
          ? release.published_at
          : null;
      return {
        tag_name: release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
        published_at: publishedAt,
      };
    });
}

/**
 * Runs of one workflow created on or after `since`, newest first. The API's
 * date filter has day granularity, and one day of a busy dispatcher can exceed
 * a page, so paginate and cut to the exact time here.
 * @param {string} workflow
 * @param {number} since
 * @returns {{status: string, conclusion: string | null, event: string, created_at: string, html_url: string, display_title: string, head_sha: string, updated_at: string, run_attempt:number}[]}
 */
function workflowRuns(workflow, since) {
  const day = new Date(since).toISOString().slice(0, 10);
  const pages = /** @type {unknown} */ (
    JSON.parse(
      gh(
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/actions/workflows/${workflow}/runs?per_page=100&created=>=${day}`,
      ),
    )
  );
  if (!Array.isArray(pages)) throw new Error(`Invalid run listing for ${workflow}`);
  /** @type {unknown[]} */
  const runs = [];
  for (const entry of pages) {
    const page = /** @type {unknown} */ (entry);
    if (typeof page !== 'object' || page === null || !('workflow_runs' in page))
      throw new Error(`Invalid run listing for ${workflow}`);
    const entries = /** @type {unknown} */ (page.workflow_runs);
    if (!Array.isArray(entries)) throw new Error(`Invalid run listing for ${workflow}`);
    for (const run of entries) runs.push(/** @type {unknown} */ (run));
  }
  const parsed = runs.map((entry) => {
    const run = /** @type {unknown} */ (entry);
    if (
      typeof run !== 'object' ||
      run === null ||
      !('status' in run) ||
      typeof run.status !== 'string' ||
      !('event' in run) ||
      typeof run.event !== 'string' ||
      !('created_at' in run) ||
      typeof run.created_at !== 'string' ||
      !Number.isFinite(Date.parse(run.created_at)) ||
      !('html_url' in run) ||
      typeof run.html_url !== 'string'
    )
      throw new Error(`Invalid run listing for ${workflow}`);
    if (
      'run_attempt' in run &&
      (!Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) < 1)
    )
      throw new Error('Invalid workflow attempt number');
    const conclusion =
      'conclusion' in run && typeof run.conclusion === 'string' ? run.conclusion : null;
    const title =
      'display_title' in run && typeof run.display_title === 'string' ? run.display_title : '';
    return {
      run_attempt:
        'run_attempt' in run &&
        Number.isSafeInteger(run.run_attempt) &&
        Number(run.run_attempt) >= 1
          ? Number(run.run_attempt)
          : 1,
      status: run.status,
      conclusion,
      event: run.event,
      created_at: run.created_at,
      updated_at:
        'updated_at' in run && typeof run.updated_at === 'string' ? run.updated_at : run.created_at,
      html_url: run.html_url,
      display_title: title,
      head_sha: 'head_sha' in run && typeof run.head_sha === 'string' ? run.head_sha : '',
    };
  });
  return parsed
    .filter((run) => Date.parse(run.created_at) >= since)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** @param {string} train */
function manifestTag(train) {
  const spec = trains[train];
  if (!spec) throw new Error(`Unknown train ${train}`);
  const manifest = /** @type {unknown} */ (JSON.parse(readFileSync(spec.manifest, 'utf8')));
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    throw new Error(`Invalid ${train} release manifest`);
  const version = /** @type {Record<string, unknown>} */ (manifest)[spec.path];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Invalid ${train} release manifest version`);
  return `${spec.prefix}${version}`;
}

/** @type {string[]} */
const notes = [];
/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const dispatched = [];
const published = releases();

/**
 * Every train with a merged release PR the label still calls pending, and what
 * exists for its version. Release Please moves the label when it creates the
 * draft, so a draft or a published tag next to a pending label is a recovery
 * in progress or a label left behind — unless a run since the merge is still
 * going, in which case it is that run's business.
 * @type {{train: string, numbers: string, tag: string, release: {draft: boolean} | undefined, merged: number}[]}
 */
const stranded = [];
for (const [train, spec] of Object.entries(trains)) {
  const pending = pendingReleasePrs(spec.component);
  if (!pending.length) continue;
  const numbers = pending.map((pr) => `#${pr.number}`).join(', ');
  if (pending.length > 1) {
    problems.push(
      `${train}: release PRs ${numbers} are all merged with the pending label; resolve the duplicate before publication can resume.`,
    );
    continue;
  }
  const merged = Date.parse(pending[0]?.mergedAt ?? '');
  if (!Number.isFinite(merged)) throw new Error(`Release PR ${numbers} has no merge time`);
  const tag = manifestTag(train);
  stranded.push({
    train,
    numbers,
    tag,
    release: published.find((entry) => entry.tag_name === tag),
    merged,
  });
}
if (stranded.length) {
  // Only runs since the merge say anything about it. Any of them still running
  // — the merge's own push run queued behind a train lock, a later push that
  // now owns the pending train, an earlier reconcile run — may yet publish, so
  // wait rather than stack another. Among the finished ones only reconcile
  // runs count: a failed re-plan or recovery run of another train says nothing
  // about this release. A reconcile run that failed is a red run a human
  // already has to read, so name it rather than repeat it every sweep; and
  // green reconcile runs that left the release unpublished mean the lifecycle
  // and this sweep disagree about what is pending, which no retry settles.
  const since = Math.min(...stranded.map((entry) => entry.merged));
  const runs = since > now - graceMs ? [] : workflowRuns(releaseWorkflow, since);
  const active = runs.find((run) => run.status !== 'completed');
  if (since > now - graceMs) {
    notes.push(
      `${releaseWorkflow}: the merge is younger than the push run lag; waiting for its own run.`,
    );
  } else if (active) {
    notes.push(
      `${releaseWorkflow}: run ${active.html_url} since the merge is still ${active.status}.`,
    );
  } else {
    /** @type {string[]} */
    const missing = [];
    for (const { train, numbers, tag, release } of stranded) {
      if (release?.draft) {
        problems.push(
          `${train}: release PR ${numbers} is merged and ${tag} exists as a draft; finish that publication through the recovery inputs of ${releaseWorkflow}.`,
        );
      } else if (release) {
        problems.push(
          `${train}: ${tag} is published but release PR ${numbers} still carries the pending label; move it to "autorelease: tagged".`,
        );
      } else {
        notes.push(`${train}: release PR ${numbers} is merged and ${tag} does not exist yet.`);
        missing.push(train);
      }
    }
    const reconciles = runs.filter((run) => run.display_title === reconcileRunTitle);
    const latest = reconciles[0];
    if (!missing.length) {
      // Nothing a reconcile run could publish.
    } else if (latest && latest.conclusion !== 'success') {
      problems.push(
        `${releaseWorkflow}: the last reconcile run ${latest.html_url} ended with ${latest.conclusion ?? 'no conclusion'} and ${missing.join(', ')} above is still unpublished; fix the cause, then re-run it or dispatch ${releaseWorkflow} with reconcile=true.`,
      );
    } else if (reconciles.length >= 2) {
      problems.push(
        `${releaseWorkflow}: ${reconciles.length} reconcile runs since the merge ended green without publishing ${missing.join(', ')} above (last: ${latest?.html_url}); the lifecycle does not consider it pending, so inspect the release PR labels and manifests.`,
      );
    } else {
      gh('workflow', 'run', releaseWorkflow, '--ref', 'main', '-f', 'reconcile=true');
      dispatched.push(`${releaseWorkflow} (reconcile=true)`);
    }
  }
}

// An existing PR can be stale when a newer push never starts its workflow.
/** @param {string} number @param {boolean} backend @param {boolean} [ota] @param {boolean} [website] */
function refreshOpenReleasePr(number, backend, ota = false, website = false) {
  if (!/^\d+$/.test(number)) throw new Error('Ambiguous open release PR');
  const head = git('rev-parse', 'HEAD');
  const currentMain = () => {
    const raw = /** @type {unknown} */ (
      JSON.parse(gh('api', `repos/${repository}/git/ref/heads/main`))
    );
    return /** @type {{object:{sha:string}}} */ (raw).object.sha;
  };
  const pr = () => {
    const raw = /** @type {unknown} */ (
      JSON.parse(gh('api', `repos/${repository}/pulls/${number}`))
    );
    return /** @type {{state:string,user:{login:string},head:{sha:string}}} */ (raw);
  };
  const original = pr();
  if (
    original.state !== 'open' ||
    !isReleaseBotLogin(original.user.login) ||
    !/^[a-f0-9]{40}$/.test(original.head.sha)
  )
    throw new Error('Invalid open release PR identity');
  if (currentMain() !== head) return;
  const time = Date.parse(git('log', '-1', '--format=%cI'));
  if (!Number.isFinite(time)) throw new Error('Invalid Main commit time');
  // The OTA workflow publishes as well as plans, so it keeps the full lag.
  if (time > now - (ota ? graceMs : planningGraceMs)) return;
  const rawComparison = /** @type {unknown} */ (
    JSON.parse(gh('api', `repos/${repository}/compare/${original.head.sha}...${head}`))
  );
  const comparison = /** @type {{ahead_by:number}} */ (rawComparison);
  if (!Number.isInteger(comparison.ahead_by) || comparison.ahead_by < 0)
    throw new Error('Invalid release comparison');
  if (comparison.ahead_by === 0) return;
  const workflow = ota ? 'mobile-ota.yml' : releaseWorkflow;
  const runs = workflowRuns(workflow, time);
  if (runs.some((run) => run.status !== 'completed')) return;
  const title = `Replan ${website ? 'website' : backend ? 'server' : 'native mobile'} ${head}`;
  if (runs.some((run) => (ota ? run.head_sha === head : run.display_title === title))) {
    notes.push(
      `Release PR #${number}: planning already attempted for ${head}; inspect that run before retrying.`,
    );
    return;
  }
  const latest = pr();
  if (currentMain() !== head || latest.state !== 'open' || latest.head.sha !== original.head.sha)
    return;
  const flag = website
    ? 'website-replan=true'
    : backend
      ? 'backend-replan=true'
      : 'mobile-replan=true';
  if (ota) gh('workflow', 'run', workflow, '--ref', 'main');
  else gh('workflow', 'run', workflow, '--ref', 'main', '-f', flag);
  dispatched.push(ota ? workflow : `${workflow} (${flag})`);
  notes.push(`Refreshing stale release PR #${number} for Main ${head}.`);
}

// A newer Server release push can displace Mobile planning without owning it.
// Publication recovery alone cannot notice a release PR that was never created.
function reconcileNativePlanning() {
  const tag = manifestTag('mobile');
  const boundary = published.find((entry) => entry.tag_name === tag);
  if (!boundary || boundary.draft || stranded.some((entry) => entry.train === 'mobile')) {
    notes.push('Mobile planning: native publication must finish before planning another release.');
    return;
  }
  const openNativePrs = () =>
    gh(
      'api',
      '--paginate',
      `repos/${repository}/pulls?state=open&base=main&per_page=100`,
      '--jq',
      '.[] | select(.head.ref == "release-please--branches--main--components--mobile") | .number',
    );
  const openNative = openNativePrs();
  if (openNative) {
    refreshOpenReleasePr(openNative, false);
    notes.push('Mobile planning: a native Staging release PR already exists.');
    return;
  }
  const head = git('rev-parse', 'HEAD');
  const currentMain = () => {
    const value = /** @type {unknown} */ (
      JSON.parse(gh('api', `repos/${repository}/git/ref/heads/main`))
    );
    const ref = /** @type {{object: {sha: string}}} */ (value);
    if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Invalid Main revision');
    return ref.object.sha;
  };
  if (currentMain() !== head) {
    notes.push('Mobile planning: Main advanced; a later sweep will evaluate it.');
    return;
  }
  const headTime = Date.parse(git('log', '-1', '--format=%cI'));
  if (!Number.isFinite(headTime)) throw new Error('Invalid Main commit time');
  if (headTime > now - planningGraceMs) {
    notes.push('Mobile planning: Main is younger than the push run lag.');
    return;
  }
  git('merge-base', '--is-ancestor', tag, head);
  const baselineTime = Date.parse(git('log', '-1', '--format=%cI', tag));
  if (!Number.isFinite(baselineTime)) throw new Error('Invalid native boundary time');
  const runs = workflowRuns(releaseWorkflow, baselineTime);
  const active = runs.find((run) => run.status !== 'completed');
  if (active) {
    notes.push(`Mobile planning: dispatcher ${active.html_url} is still ${active.status}.`);
    return;
  }
  const paths = git('diff', '--no-renames', '--name-only', '-z', tag, head, '--')
    .split('\0')
    .filter(Boolean);
  if (!paths.some((path) => nativePathKind(path) !== 'ota')) {
    notes.push('Mobile planning: only OTA-compatible source paths changed.');
    return;
  }
  if (!paths.some((path) => nativePathKind(path) === 'native')) {
    // Fingerprinting needs the locked Expo tooling, unlike the cheap path filter.
    execFileSync('npm', ['ci'], { stdio: 'inherit' });
  }
  const changes = execFileSync(
    process.execPath,
    ['scripts/mobile-native-compatibility.mjs', tag, head],
    { encoding: 'utf8' },
  ).trim();
  if (!changes) {
    notes.push('Mobile planning: native fingerprint is unchanged; updates stay on OTA.');
    return;
  }
  const title = `Replan native mobile ${head}`;
  const previous = runs.find((run) => run.display_title === title);
  if (previous) {
    problems.push(
      `Mobile planning: ${previous.html_url} ended with ${previous.conclusion ?? 'no conclusion'} but no native Staging PR exists; inspect and retry that planning run.`,
    );
    return;
  }
  if (currentMain() !== head || openNativePrs()) {
    notes.push('Mobile planning: Main or its release PR changed during classification.');
    return;
  }
  gh('workflow', 'run', releaseWorkflow, '--ref', 'main', '-f', 'mobile-replan=true');
  dispatched.push(`${releaseWorkflow} (mobile-replan=true)`);
  notes.push(`Mobile planning: native changes since ${tag} had no Staging release PR: ${changes}`);
}
/** @param {'backend' | 'website'} train */
function reconcilePlanning(train) {
  const website = train === 'website';
  const label = website ? 'Website' : 'Server';
  const component = website ? 'website' : 'server';
  const path = website ? 'docs/website' : '.';
  const tag = manifestTag(train);
  const boundary = published.find((entry) => entry.tag_name === tag);
  if (!boundary || boundary.draft || stranded.some((entry) => entry.train === train)) {
    notes.push(
      `${label} planning: ${label} publication must finish before planning another release.`,
    );
    return;
  }
  const openReleasePrs = () =>
    gh(
      'api',
      '--paginate',
      `repos/${repository}/pulls?state=open&base=main&per_page=100`,
      '--jq',
      `.[] | select(.head.ref == "release-please--branches--main--components--${component}") | .number`,
    );
  const openRelease = openReleasePrs();
  if (openRelease) {
    refreshOpenReleasePr(openRelease, !website, false, website);
    notes.push(`${label} planning: a ${label} Staging release PR already exists.`);
    return;
  }
  const head = git('rev-parse', 'HEAD');
  const currentMain = () => {
    const value = /** @type {unknown} */ (
      JSON.parse(gh('api', `repos/${repository}/git/ref/heads/main`))
    );
    const ref = /** @type {{object: {sha: string}}} */ (value);
    if (!/^[a-f0-9]{40}$/.test(ref.object.sha)) throw new Error('Invalid Main revision');
    return ref.object.sha;
  };
  if (currentMain() !== head) {
    notes.push(`${label} planning: Main advanced; a later sweep will evaluate it.`);
    return;
  }
  const headTime = Date.parse(git('log', '-1', '--format=%cI'));
  if (!Number.isFinite(headTime)) throw new Error('Invalid Main commit time');
  if (headTime > now - planningGraceMs) {
    notes.push(`${label} planning: Main is younger than the push run lag.`);
    return;
  }
  git('merge-base', '--is-ancestor', tag, head);
  const baselineTime = Date.parse(git('log', '-1', '--format=%cI', tag));
  if (!Number.isFinite(baselineTime)) throw new Error(`Invalid ${label} boundary time`);
  const runs = workflowRuns(releaseWorkflow, baselineTime);
  const active = runs.find((run) => run.status !== 'completed');
  if (active) {
    notes.push(`${label} planning: dispatcher ${active.html_url} is still ${active.status}.`);
    return;
  }
  // Use Release Please's exclusions so mobile-only changes cannot create Server plans.
  const config = /** @type {unknown} */ (
    JSON.parse(readFileSync(`release-please-config.${train}.json`, 'utf8'))
  );
  if (!config || typeof config !== 'object' || !('packages' in config))
    throw new Error(`Invalid ${train} release config`);
  const packages = config.packages;
  if (!packages || typeof packages !== 'object' || !(path in packages))
    throw new Error(`Invalid ${train} release packages`);
  const server = /** @type {Record<string, unknown>} */ (packages)[path];
  if (!server || typeof server !== 'object' || !('exclude-paths' in server))
    throw new Error(`Invalid ${train} release package`);
  const excludes = server['exclude-paths'];
  if (!Array.isArray(excludes) || excludes.some((path) => typeof path !== 'string'))
    throw new Error(`Invalid ${train} release exclusions`);
  const commits = git(
    'log',
    '--format=%B%x00',
    `${tag}..${head}`,
    '--',
    path,
    ...excludes.map((path) => `:(exclude)${path}`),
  );
  if (
    !commits
      .split('\0')
      .some(
        (subject) =>
          /^(?:feat|fix|perf|revert)(?:\([^)]*\))?!?:|^[a-z]+(?:\([^)]*\))?!:/m.test(
            subject.trimStart(),
          ) || /^BREAKING[ -]CHANGE: /m.test(subject),
      )
  ) {
    notes.push(`${label} planning: no releasable ${label} commits since the published boundary.`);
    return;
  }
  const title = `Replan ${component} ${head}`;
  const previous = runs.find((run) => run.display_title === title);
  if (previous) {
    problems.push(
      `${label} planning: ${previous.html_url} ended with ${previous.conclusion ?? 'no conclusion'} but no ${label} Staging PR exists; inspect and retry that planning run.`,
    );
    return;
  }
  if (currentMain() !== head || openReleasePrs()) {
    notes.push(`${label} planning: Main or its release PR changed during classification.`);
    return;
  }
  const flag = `${train}-replan=true`;
  gh('workflow', 'run', releaseWorkflow, '--ref', 'main', '-f', flag);
  dispatched.push(`${releaseWorkflow} (${flag})`);
  notes.push(
    `${label} planning: releasable commits since ${tag} had no Staging release PR: ${head}`,
  );
}
reconcilePlanning('website');
reconcilePlanning('backend');

reconcileNativePlanning();

// OTA planning owns its compatibility and publication gates in its own workflow.
const openOta = gh(
  'api',
  '--paginate',
  `repos/${repository}/pulls?state=open&base=main&per_page=100`,
  '--jq',
  '.[] | select(.head.ref == "release-please--branches--main--components--mobile-ota") | .number',
);
if (openOta) refreshOpenReleasePr(openOta, false, true);

// A merged Staging OTA release PR is published by the mobile-ota.yml run its
// merge push starts. A lost push leaves the version on main with no tag, which
// a dispatch at the main head stages exactly like the push would have.
function reconcileOtaStaging() {
  const versionPath = 'apps/mobile/ota/version.txt';
  if (!existsSync(versionPath) || !existsSync('apps/mobile/version.txt')) return;
  const version = readFileSync(versionPath, 'utf8').trim();
  const native = readFileSync('apps/mobile/version.txt', 'utf8').trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  // A .0 marker or a retired runtime means planning, which the OTA workflow
  // decides on every push; there is nothing published to recover.
  if (!match || match[3] === '0' || `${match[1]}.${match[2]}.0` !== native) return;
  const tag = `mobile-v${version}`;
  if (published.some((entry) => entry.tag_name === tag && !entry.draft)) return;
  const mergedAt = Date.parse(git('log', '-1', '--format=%cI', '--', versionPath));
  if (!Number.isFinite(mergedAt)) throw new Error('OTA version marker has no history');
  if (mergedAt > now - graceMs) {
    notes.push(
      `OTA Staging: ${tag} merged less than the push run lag ago; waiting for its own run.`,
    );
    return;
  }
  // Without its native runtime the run waits and publishes nothing, so only
  // runs after that runtime reached Staging count as attempts.
  const runtime = published.find((entry) => entry.tag_name === `mobile-v${native}` && !entry.draft);
  if (!runtime) {
    notes.push(`OTA Staging: ${tag} waits for native ${native} to reach Staging.`);
    return;
  }
  const runtimeAt = Date.parse(runtime.published_at ?? '');
  const runs = workflowRuns(
    otaWorkflow,
    Number.isFinite(runtimeAt) ? Math.max(mergedAt, runtimeAt) : mergedAt,
  );
  const latest = runs.find((run) => run.status !== 'completed') ?? runs[0];
  if (latest && latest.status !== 'completed') {
    notes.push(`OTA Staging: run ${latest.html_url} for ${tag} is still ${latest.status}.`);
  } else if (!latest || runs.length < 2) {
    // One more run covers a lost push, a transient failure, and a run that
    // waited for its native runtime before that runtime was published.
    gh('workflow', 'run', otaWorkflow, '--ref', 'main');
    dispatched.push(otaWorkflow);
    notes.push(
      latest
        ? `OTA Staging: ${tag} is still unpublished after ${latest.html_url} ended with ${latest.conclusion ?? 'no conclusion'}; running it once more.`
        : `OTA Staging: ${tag} is merged and no OTA run followed its merge.`,
    );
  } else {
    problems.push(
      `OTA Staging: ${tag} is merged but unpublished after ${runs.length} runs, the last ${latest.html_url} ended with ${latest.conclusion ?? 'no conclusion'}; inspect it before dispatching ${otaWorkflow} again.`,
    );
  }
}
reconcileOtaStaging();

/**
 * The tag a promotion manifest delivers, or undefined when the manifest does
 * not have that product's shape.
 * @param {'ota' | 'server' | 'native'} kind
 * @param {unknown} candidate
 */
function promotionTag(kind, candidate) {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const field = (/** @type {string} */ name) =>
    name in candidate ? /** @type {Record<string, unknown>} */ (candidate)[name] : undefined;
  const version = field('version');
  if (kind === 'server')
    return field('schema') === 1 &&
      field('product') === 'server' &&
      typeof version === 'string' &&
      /^\d+\.\d+\.\d+$/.test(version)
      ? `v${version}`
      : undefined;
  if (kind === 'native')
    return (field('schema') === 1 || field('schema') === 2) &&
      field('product') === 'mobile-native' &&
      typeof version === 'string' &&
      /^\d+\.\d+\.0$/.test(version)
      ? `mobile-v${version}`
      : undefined;
  const tag = field('tag');
  const runtime = field('runtime');
  return typeof tag === 'string' &&
    /^mobile-v\d+\.\d+\.\d+$/.test(tag) &&
    typeof runtime === 'string' &&
    /^\d+\.\d+\.0$/.test(runtime)
    ? tag
    : undefined;
}

/** GitHub's persisted receipt is authoritative for new runs; older runs are
 * associated by their actual checked-out manifest and pipeline Git objects.
 * @param {import('./promotion-recovery.mjs').PromotionKind} kind
 * @param {{head_sha:string,html_url:string}} run
 * @param {number | undefined} attempt
 */
function recoveryRun(kind, run, attempt = undefined) {
  const match = /\/actions\/runs\/(\d+)$/.exec(run.html_url);
  if (!match) throw new Error('Invalid promotion run URL');
  const pages = /** @type {unknown} */ (
    JSON.parse(
      gh(
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository}/actions/runs/${match[1]}${attempt ? `/attempts/${attempt}` : ''}/jobs?per_page=100`,
      ),
    )
  );
  if (!Array.isArray(pages)) throw new Error('Invalid promotion job metadata');
  /** @type {{name?:string, conclusion?:string, completed_at?:string}[]} */
  const steps = [];
  for (const entry of pages) {
    const page = /** @type {unknown} */ (entry);
    if (typeof page !== 'object' || page === null || !('jobs' in page) || !Array.isArray(page.jobs))
      throw new Error('Invalid promotion jobs');
    for (const entry of page.jobs) {
      const job = /** @type {unknown} */ (entry);
      if (typeof job !== 'object' || job === null || !('steps' in job) || !Array.isArray(job.steps))
        throw new Error('Invalid promotion steps');
      for (const entry of job.steps) {
        const step = /** @type {unknown} */ (entry);
        if (
          typeof step !== 'object' ||
          step === null ||
          !('name' in step) ||
          typeof step.name !== 'string'
        )
          throw new Error('Invalid promotion step');
        steps.push({
          name: step.name,
          ...('completed_at' in step && typeof step.completed_at === 'string'
            ? { completed_at: step.completed_at }
            : {}),
          ...('conclusion' in step && typeof step.conclusion === 'string'
            ? { conclusion: step.conclusion }
            : {}),
        });
      }
    }
  }
  const receipt = parseRecoveryReceipt(steps);
  const receiptStep = steps.find(
    (step) => step.conclusion !== 'skipped' && step.name?.startsWith('recovery-v1:'),
  );
  const nativeDelivery =
    kind === 'native'
      ? steps.find(
          (step) =>
            step.name === 'Upload approved production binary to TestFlight' &&
            step.conclusion === 'success',
        )
      : undefined;
  const completedAt = receiptStep?.completed_at ?? nativeDelivery?.completed_at;
  const historical = promotionIdentity(kind, run.head_sha);
  if (receipt && receipt.candidate !== historical.candidate)
    throw new Error('Promotion receipt differs from its checked-out revision');
  return {
    ...historical,
    pipeline: receipt?.pipeline ?? historical.pipeline,
    state: receipt?.state,
    completedAt,
  };
}

/** @param {string} tag */
function freshProduction(tag) {
  const matches = releases().filter((entry) => entry.tag_name === tag);
  if (matches.length > 1) throw new Error(`Ambiguous release metadata for ${tag}`);
  const release = matches[0];
  return release && !release.draft && !release.prerelease ? release : undefined;
}

for (const { kind, manifest, workflow, label } of [
  // Each promotion is idempotent: moving an EAS channel, copying signed image
  // tags, and the native upload, which reuses a build Apple already has. A
  // failed attempt is therefore retried once before a human is asked.
  /** @type {const} */ ({
    kind: 'ota',
    manifest: otaManifest,
    workflow: promoteWorkflow,
    label: 'OTA',
  }),
  /** @type {const} */ ({
    kind: 'server',
    manifest: 'releases/server-production.json',
    workflow: 'server-production-promote.yml',
    label: 'Server',
  }),
  /** @type {const} */ ({
    kind: 'native',
    manifest: 'releases/mobile-production.json',
    workflow: nativePromoteWorkflow,
    label: 'Native',
  }),
]) {
  try {
    if (!existsSync(manifest)) continue;
    const candidate = /** @type {unknown} */ (JSON.parse(readFileSync(manifest, 'utf8')));
    const tag = promotionTag(kind, candidate);
    if (!tag) throw new Error(`Invalid ${label} promotion manifest`);
    if (freshProduction(tag)) continue;
    // The manifest on main only changes through a merged promotion PR, so an
    // unpublished tag means an approved candidate whose delivery never ran or
    // never finished. The commit date is the merge time because main takes
    // squash merges only, which the release-please job enforces before every
    // release.
    const approvedAt = Date.parse(git('log', '-1', '--format=%cI', '--', manifest));
    if (!Number.isFinite(approvedAt)) throw new Error(`${label} promotion manifest has no history`);
    if (approvedAt > now - graceMs) {
      notes.push(
        `${label}: ${tag} was approved less than the push run lag ago; waiting for its own run.`,
      );
      continue;
    }
    const identity = promotionIdentity(kind);
    const runs = workflowRuns(workflow, approvedAt);
    const active = runs.find((run) => run.status !== 'completed');
    if (active) {
      notes.push(
        `${label}: promotion run ${active.html_url} for ${tag} is still ${active.status}.`,
      );
      continue;
    }
    // Publication may have finished while workflow metadata was being read.
    if (freshProduction(tag)) continue;
    let readyAt = approvedAt;
    if (kind === 'ota') {
      const runtime = /** @type {{runtime:string}} */ (candidate).runtime;
      const nativeRelease = freshProduction(`mobile-v${runtime}`);
      if (!nativeRelease) {
        notes.push(`${label}: ${tag} waits for native production approval of ${runtime}.`);
        continue;
      }
      // A native run can start before OTA approval and finish afterwards. Search
      // across its history, and match the exact version. Release publication dates
      // may describe its earlier staging publication, not the production transition.
      const publishedAt = Date.parse(nativeRelease.published_at ?? '');
      if (!Number.isFinite(publishedAt))
        throw new Error('Native runtime has no publication history');
      const nativeRuns = workflowRuns(nativePromoteWorkflow, 0);
      let transition = Infinity;
      for (const nativeRun of nativeRuns) {
        if (nativeRun.status !== 'completed') continue;
        if (nativeRun.run_attempt === 1 && nativeRun.conclusion !== 'success') continue;
        for (let attempt = 1; attempt <= nativeRun.run_attempt; attempt++) {
          const evidence = recoveryRun(
            'native',
            nativeRun,
            nativeRun.run_attempt > 1 ? attempt : undefined,
          );
          if (
            evidence.manifest.version !== runtime ||
            (evidence.state && evidence.state !== 'success')
          )
            continue;
          // Rerunning an old native run changes updated_at. Its original delivery
          // time must come from that attempt's persisted step, not the latest rerun.
          const completed = Date.parse(
            evidence.completedAt ?? (nativeRun.run_attempt === 1 ? nativeRun.updated_at : ''),
          );
          if (!Number.isFinite(completed))
            throw new Error('Native rerun has no verifiable publication completion time');
          transition = Math.min(transition, completed);
        }
      }
      if (Number.isFinite(transition)) readyAt = Math.max(readyAt, transition);
    }
    const attempts = [];
    for (const run of runs) {
      // GitHub reruns keep one run ID. Count their persisted delivery outcomes,
      // otherwise a manual rerun could accidentally buy another automatic retry.
      for (let attempt = run.run_attempt; attempt >= 1; attempt--) {
        const evidence = recoveryRun(kind, run, run.run_attempt > 1 ? attempt : undefined);
        if (evidence.candidate !== identity.candidate) continue;
        if (evidence.state === 'deferred' || evidence.state === 'skipped') continue;
        if (evidence.pipeline !== identity.pipeline) continue;
        const completed = Date.parse(run.updated_at);
        if (!Number.isFinite(completed)) throw new Error('Invalid promotion completion time');
        if (!evidence.state && run.run_attempt > 1)
          throw new Error('Historical rerun has no explicit delivery outcome');
        // Historical green waits need exact runtime transition evidence. Genuine
        // failures remain counted even after a later native publication.
        if (!evidence.state && run.conclusion === 'success' && completed < readyAt) continue;
        attempts.push({ ...run, conclusion: evidence.state ?? run.conclusion });
      }
    }
    // Refresh both publication facts after collecting historical evidence.
    // A runtime can change while jobs are read just as the candidate can finish.
    if (freshProduction(tag)) continue;
    if (
      kind === 'ota' &&
      !freshProduction(`mobile-v${/** @type {{runtime:string}} */ (candidate).runtime}`)
    ) {
      notes.push(`${label}: ${tag} waits for its exact native production runtime.`);
      continue;
    }
    const latest = attempts[0];
    if (latest?.conclusion === 'success') {
      if (freshProduction(tag)) continue;
      problems.push(
        `${label}: ${tag} is approved but unpublished although promotion run ${latest.html_url} ended green; inspect its delivery evidence before retrying.`,
      );
    } else if (attempts.length < 2) {
      // Recheck Main immediately before enqueueing; workflow preflight additionally
      // compares candidate and pipeline after checkout, before publication effects.
      const main = /** @type {unknown} */ (
        JSON.parse(gh('api', `repos/${repository}/git/ref/heads/main`))
      );
      if (
        typeof main !== 'object' ||
        main === null ||
        !('object' in main) ||
        typeof main.object !== 'object' ||
        main.object === null ||
        !('sha' in main.object) ||
        typeof main.object.sha !== 'string'
      )
        throw new Error('Invalid Main reference');
      if (main.object.sha !== git('rev-parse', 'HEAD')) {
        notes.push(`${label}: Main advanced; a fresh sweep owns recovery.`);
        continue;
      }
      if (freshProduction(tag)) continue;
      if (
        kind === 'ota' &&
        !freshProduction(`mobile-v${/** @type {{runtime:string}} */ (candidate).runtime}`)
      )
        continue;
      gh(
        'workflow',
        'run',
        workflow,
        '--ref',
        'main',
        '-f',
        `recovery-candidate=${identity.candidate}`,
        '-f',
        `recovery-pipeline=${identity.pipeline}`,
      );
      dispatched.push(workflow);
      notes.push(
        latest
          ? `${label}: promotion run ${latest.html_url} ended with ${latest.conclusion}; retrying once for this candidate and pipeline.`
          : `${label}: ${tag} is approved and no promotion run followed it for this pipeline.`,
      );
    } else {
      if (freshProduction(tag)) continue;
      problems.push(
        `${label}: ${tag} is approved but unpublished after an automatic retry for this candidate and pipeline; last run ${latest?.html_url}. A relevant pipeline fix allows a new bounded attempt.`,
      );
    }
  } catch (error) {
    problems.push(
      `${label}: recovery state could not be verified: ${error instanceof Error ? error.message : String(error)}; no promotion dispatched.`,
    );
  }
}

const lines = [
  ...notes.map((note) => `- ${note}`),
  ...dispatched.map((target) => `- dispatched ${target}`),
  ...problems.map((problem) => `- needs attention: ${problem}`),
];
const summary = lines.length ? lines.join('\n') : '- nothing to reconcile';
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release reconciliation\n\n${summary}\n`);
// release-alarm.mjs reads the verdict; a missing output means the sweep crashed.
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `problems=${JSON.stringify(problems)}\n`);
for (const problem of problems) console.log(`::error::${problem}`);
if (problems.length) process.exitCode = 1;
