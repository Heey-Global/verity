#!/usr/bin/env node
// Missed-event backstop for release publication; see release-reconcile.yml.
// Publication is event-driven, and a push event GitHub never delivered leaves
// a merged release PR or an approved OTA candidate with no run at all. This
// script detects those and dispatches the ordinary workflows. It publishes
// nothing itself, and it reports states that need a human as errors instead
// of retrying them every sweep.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { nativePathKind } from './mobile-native-compatibility.mjs';
import { pendingReleasePrs } from './pending-release-prs.mjs';

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
/** The `run-name` release-dispatch.yml gives a reconcile run and nothing else. */
const reconcileRunTitle = 'Reconcile unpublished releases';
/**
 * GitHub creates the push run for a merge some time after the merge, minutes
 * under load. A merge younger than this is still the push run's to publish;
 * dispatching against it would only race that run for the train lock.
 */
const graceMs = 10 * 60 * 1000;
const now = Date.now();

/** @param {string[]} args */
const gh = (...args) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
/** @param {string[]} args */
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** @returns {{tag_name: string, draft: boolean, prerelease: boolean}[]} */
function releases() {
  // Paginate: a release missing from page one must never look unpublished.
  return gh(
    'api',
    '--paginate',
    '--jq',
    '.[] | {tag_name, draft, prerelease}',
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
      return { tag_name: release.tag_name, draft: release.draft, prerelease: release.prerelease };
    });
}

/**
 * Runs of one workflow created on or after `since`, newest first. The API's
 * date filter has day granularity, and one day of a busy dispatcher can exceed
 * a page, so paginate and cut to the exact time here.
 * @param {string} workflow
 * @param {number} since
 * @returns {{status: string, conclusion: string | null, event: string, created_at: string, html_url: string, display_title: string}[]}
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
      !('html_url' in run) ||
      typeof run.html_url !== 'string'
    )
      throw new Error(`Invalid run listing for ${workflow}`);
    const conclusion =
      'conclusion' in run && typeof run.conclusion === 'string' ? run.conclusion : null;
    const title =
      'display_title' in run && typeof run.display_title === 'string' ? run.display_title : '';
    return {
      status: run.status,
      conclusion,
      event: run.event,
      created_at: run.created_at,
      html_url: run.html_url,
      display_title: title,
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
  if (openNativePrs()) {
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
  if (headTime > now - graceMs) {
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
  const paths = git('diff', '--name-only', tag, head).split('\n').filter(Boolean);
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
reconcileNativePlanning();

if (existsSync(otaManifest)) {
  const candidate = /** @type {unknown} */ (JSON.parse(readFileSync(otaManifest, 'utf8')));
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('tag' in candidate) ||
    typeof candidate.tag !== 'string' ||
    !/^mobile-v\d+\.\d+\.\d+$/.test(candidate.tag)
  )
    throw new Error('Invalid OTA promotion manifest');
  const tag = candidate.tag;
  const delivered = published.some(
    (entry) => entry.tag_name === tag && !entry.draft && !entry.prerelease,
  );
  if (!delivered) {
    // The manifest on main only changes through a merged promotion PR, so an
    // unpublished tag means an approved candidate whose delivery never ran or
    // never finished. Retry only the former: a failed run is a red run that a
    // human already has to look at, not something to hammer every sweep. The
    // commit date is the merge time because main takes squash merges only,
    // which the release-please job enforces before every release.
    const approvedAt = Date.parse(git('log', '-1', '--format=%cI', '--', otaManifest));
    if (!Number.isFinite(approvedAt)) throw new Error('OTA promotion manifest has no history');
    const latest =
      approvedAt > now - graceMs ? undefined : workflowRuns(promoteWorkflow, approvedAt)[0];
    if (approvedAt > now - graceMs) {
      notes.push(
        `OTA: ${tag} was approved less than the push run lag ago; waiting for its own run.`,
      );
    } else if (!latest) {
      gh('workflow', 'run', promoteWorkflow, '--ref', 'main');
      dispatched.push(promoteWorkflow);
      notes.push(`OTA: ${tag} is approved and no promotion run followed its merge.`);
    } else if (latest.status !== 'completed') {
      notes.push(`OTA: promotion run ${latest.html_url} for ${tag} is still ${latest.status}.`);
    } else if (latest.conclusion === 'success') {
      problems.push(
        `OTA: ${tag} is approved but unpublished although promotion run ${latest.html_url} ended green; the candidate it promoted differs from the manifest on main, so inspect the manifest history before dispatching ${promoteWorkflow} again.`,
      );
    } else {
      problems.push(
        `OTA: ${tag} is approved but unpublished and its last promotion run ${latest.html_url} ended with ${latest.conclusion ?? 'no conclusion'}; retry ${promoteWorkflow} once the cause is fixed.`,
      );
    }
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
for (const problem of problems) console.log(`::error::${problem}`);
if (problems.length) process.exitCode = 1;
