import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/release-reconcile.mjs');
const approvedAt = '2026-09-28T21:35:15Z';

type Run = {
  status: string;
  conclusion: string | null;
  event: string;
  created_at: string;
  display_title?: string;
};
type Fixture = {
  pending?: Partial<Record<'server' | 'mobile' | 'website', number[]>>;
  mergedAt?: string;
  approvedAt?: string;
  releases?: { tag_name: string; draft?: boolean; prerelease?: boolean; published_at?: string }[];
  releaseRuns?: Run[];
  promoteRuns?: Run[];
  ota?: boolean;
  serverPromotion?: boolean;
  nativePromotion?: boolean;
  /** The OTA candidate's native runtime 1.32.0; production unless stated. */
  otaRuntime?: 'production' | 'staging' | 'missing';
  otaStaging?: { version: string; native?: string };
  nativePromoteRuns?: Run[];
  serverPromoteRuns?: Run[];
  invalidServerPromotion?: boolean;
  backend?: boolean;
  website?: { path?: string; open?: boolean };
  openOta?: boolean;
  otaRuns?: Run[];
  message?: string;
  native?: {
    path?: string;
    compatible?: boolean;
    open?: boolean;
    stale?: boolean;
    mainMoved?: boolean;
    oldHead?: boolean;
    recent?: boolean;
    rename?: boolean;
  };
};

function sweep(fixture: Fixture) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-reconcile-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgSign', 'false');
  git('config', 'tag.gpgSign', 'false');
  // Assembled so the changed-area guard in ci-workflow.test.ts does not read
  // this fixture as a script consuming a release-managed file.
  const manifest = (train: string) =>
    join(cwd, ['.release-please-manifest', train, 'json'].join('.'));
  writeFileSync(manifest('backend'), JSON.stringify({ '.': '1.2.3' }));
  writeFileSync(manifest('mobile'), JSON.stringify({ 'apps/mobile': '1.33.0' }));
  writeFileSync(manifest('website'), JSON.stringify({ 'docs/website': '0.4.0' }));
  if (fixture.ota !== false) {
    mkdirSync(join(cwd, 'apps/mobile'), { recursive: true });
    writeFileSync(
      join(cwd, 'apps/mobile/ota-promotion.json'),
      // Its runtime is a separate line from the native planning boundary
      // (1.33.0), so these candidates never pull native planning in.
      JSON.stringify({ schema: 1, version: '1.33.1', runtime: '1.32.0', tag: 'mobile-v1.33.1' }),
    );
  }
  if (fixture.serverPromotion) {
    mkdirSync(join(cwd, 'releases'), { recursive: true });
    writeFileSync(
      join(cwd, 'releases/server-production.json'),
      JSON.stringify({
        schema: 1,
        product: 'server',
        version: fixture.invalidServerPromotion ? 'invalid' : '1.2.3',
      }),
    );
  }
  if (fixture.otaStaging) {
    mkdirSync(join(cwd, 'apps/mobile/ota'), { recursive: true });
    writeFileSync(join(cwd, 'apps/mobile/ota/version.txt'), `${fixture.otaStaging.version}\n`);
    writeFileSync(
      join(cwd, 'apps/mobile/version.txt'),
      `${fixture.otaStaging.native ?? '1.32.0'}\n`,
    );
  }
  if (fixture.nativePromotion) {
    mkdirSync(join(cwd, 'releases'), { recursive: true });
    writeFileSync(
      join(cwd, 'releases/mobile-production.json'),
      JSON.stringify({ schema: 2, product: 'mobile-native', version: '1.31.0' }),
    );
  }
  if (fixture.native?.rename) {
    mkdirSync(join(cwd, 'apps/mobile/plugins'), { recursive: true });
    writeFileSync(join(cwd, 'apps/mobile/plugins/capture.js'), 'native change');
  }
  if (fixture.backend || fixture.serverPromotion) {
    writeFileSync(
      join(cwd, 'release-please-config.backend.json'),
      readFileSync(resolve('release-please-config.backend.json')),
    );
  }
  git('add', '.');
  const commitDate = fixture.approvedAt ?? approvedAt;
  execFileSync('git', ['commit', '-qm', 'chore(mobile): promote OTA 1.33.1'], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
  });
  if (fixture.serverPromotion && !fixture.native) git('tag', 'v1.2.3');
  if (fixture.native) {
    git('tag', fixture.backend ? 'v1.2.3' : 'mobile-v1.33.0');
    const nativePath = fixture.native.rename
      ? 'capture.js'
      : (fixture.native.path ?? 'apps/mobile/plugins/capture.js');
    mkdirSync(resolve(cwd, nativePath, '..'), { recursive: true });
    if (fixture.native.rename) git('mv', 'apps/mobile/plugins/capture.js', nativePath);
    else writeFileSync(join(cwd, nativePath), 'native change');
    git('add', '.');
    const date = fixture.native.recent ? new Date().toISOString() : approvedAt;
    execFileSync('git', ['commit', '-qm', fixture.message ?? 'feat(tasks): capture tasks'], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    if (!fixture.native.recent) {
      writeFileSync(join(cwd, 'server-version'), 'server release');
      git('add', '.');
      execFileSync('git', ['commit', '-qm', 'chore(release): staging server 4.21.0'], {
        cwd,
        env: { ...process.env, GIT_AUTHOR_DATE: approvedAt, GIT_COMMITTER_DATE: approvedAt },
      });
    }
    mkdirSync(join(cwd, 'scripts'));
    writeFileSync(
      join(cwd, 'scripts/mobile-native-compatibility.mjs'),
      fixture.native.compatible ? '' : "console.log('Mobile native fingerprint changed');",
    );
  }
  if (fixture.website) {
    git('tag', 'website-v0.4.0');
    const path = fixture.website.path ?? 'docs/website/index.html';
    mkdirSync(resolve(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), 'website change');
    writeFileSync(
      join(cwd, 'release-please-config.website.json'),
      readFileSync(resolve('release-please-config.website.json')),
    );
    git('add', '.');
    execFileSync('git', ['commit', '-qm', fixture.message ?? 'fix(website): update page'], {
      cwd,
      env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
    });
  }
  const head = git('rev-parse', 'HEAD');
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const log = join(cwd, 'gh.log');
  writeFileSync(
    join(cwd, 'bin/gh'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const joined = args.join(' ');
const fixture = JSON.parse(process.env.RECONCILE_FIXTURE);
appendFileSync(process.env.RECONCILE_LOG, joined + '\\n');
const pr = (component, number) => ({ number, merged_at: fixture.mergedAt ?? '2026-09-28T21:35:05Z', merge_commit_sha: 'a'.repeat(40),
  user: { login: 'github-actions[bot]' }, head: { ref: 'release-please--branches--main--components--' + component }, labels: ['autorelease: pending'] });
if (joined.startsWith('workflow run')) process.exit(0);
if (!args.includes('--paginate') && /\\/(releases|pulls|runs)\\?/.test(joined)) throw new Error('listing must paginate: ' + joined);
if (joined.includes('/runs?') && (!args.includes('--slurp') || !/created=>=\\d{4}-\\d{2}-\\d{2}/.test(joined))) throw new Error('run listing must slurp pages since a day: ' + joined);
if (joined.includes('/git/ref/heads/main')) {
  const { existsSync, writeFileSync } = require('node:fs');
  const seen = process.env.RECONCILE_LOG + '.main';
  const moved = fixture.native?.oldHead || (fixture.native?.mainMoved && existsSync(seen));
  writeFileSync(seen, '1');
  process.stdout.write(JSON.stringify({object:{sha:moved ? 'f'.repeat(40) : process.env.RECONCILE_HEAD}}));
} else if (joined.includes('/pulls?state=open')) {
  process.stdout.write(joined.includes('components--mobile-ota') ? (fixture.openOta ? '42' : '') : joined.includes('components--website') ? (fixture.website?.open ? '42' : '') : (fixture.native?.open ? '42' : ''));
} else if (/\\/pulls\\/42$/.test(joined)) {
  process.stdout.write(JSON.stringify({state:'open',user:{login:'github-actions[bot]'},head:{sha:'a'.repeat(40)}}));
} else if (joined.includes('/compare/')) {
  process.stdout.write(JSON.stringify({ahead_by:fixture.native?.stale ? 1 : 0}));
} else if (joined.includes('/releases?')) {
  const runtime = fixture.otaRuntime ?? 'production';
  const rows = [...(fixture.releases ?? []), ...(runtime === 'missing' ? [] : [{ tag_name: 'mobile-v1.32.0', prerelease: runtime === 'staging', published_at: '2026-09-01T00:00:00Z' }])];
  process.stdout.write(rows.map((r) => JSON.stringify({ tag_name: r.tag_name, draft: !!r.draft, prerelease: !!r.prerelease, published_at: r.published_at ?? null })).join('\\n') + '\\n');
} else if (joined.includes('/pulls?')) {
  const rows = [];
  for (const [component, numbers] of Object.entries(fixture.pending ?? {})) for (const number of numbers) rows.push(pr(component, number));
  rows.push({ ...pr('server', 900), labels: ['autorelease: tagged'] }, { ...pr('server', 901), merged_at: null });
  process.stdout.write(rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
} else if (joined.includes('/actions/workflows/release-dispatch.yml/runs?')) {
  const runs = (fixture.releaseRuns ?? []).map((run, index) => ({ ...run, display_title: run.display_title === 'replan' ? (fixture.website ? 'Replan website ' : fixture.backend ? 'Replan server ' : 'Replan native mobile ') + process.env.RECONCILE_HEAD : run.display_title, html_url: 'https://runs.invalid/release/' + index }));
  process.stdout.write(JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }]));
} else if (joined.includes('/actions/workflows/mobile-ota.yml/runs?')) {
  process.stdout.write(JSON.stringify([{workflow_runs:(fixture.otaRuns ?? []).map((run) => ({...run,head_sha:process.env.RECONCILE_HEAD,html_url:'https://runs.invalid/ota'}))}]));
} else if (joined.includes('/actions/workflows/server-production-promote.yml/runs?')) {
  const runs = (fixture.serverPromoteRuns ?? []).map((run, index) => ({ ...run, html_url: 'https://runs.invalid/server-promote/' + index }));
  process.stdout.write(JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }]));
} else if (joined.includes('/actions/workflows/mobile-production-promote.yml/runs?')) {
  const runs = (fixture.nativePromoteRuns ?? []).map((run, index) => ({ ...run, html_url: 'https://runs.invalid/native-promote/' + index }));
  process.stdout.write(JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }]));
} else if (joined.includes('/actions/workflows/mobile-ota-promote.yml/runs?')) {
  const runs = (fixture.promoteRuns ?? []).map((run, index) => ({ ...run, html_url: 'https://runs.invalid/promote/' + index }));
  process.stdout.write(JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }]));
} else throw new Error('unexpected gh invocation: ' + joined);
`,
    { mode: 0o755 },
  );
  const summary = join(cwd, 'summary.md');
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_STEP_SUMMARY: summary,
      RECONCILE_FIXTURE: JSON.stringify(fixture),
      RECONCILE_LOG: log,
      RECONCILE_HEAD: head,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return {
    ...result,
    dispatches: calls.filter((call) => call.startsWith('workflow run')),
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

const delivered = [{ tag_name: 'mobile-v1.33.1' }];
const releaseReconcile = 'workflow run release-dispatch.yml --ref main -f reconcile=true';
const promote = 'workflow run mobile-ota-promote.yml --ref main';
const run = (overrides: Partial<Run>): Run => ({
  status: 'completed',
  conclusion: 'success',
  event: 'workflow_dispatch',
  created_at: '2026-09-28T21:40:00Z',
  ...overrides,
});
// The title release-dispatch.yml gives a reconcile run; a re-plan or recovery
// run keeps GitHub's default and must never count against a stranded release.
const reconcile = (overrides: Partial<Run> = {}): Run =>
  run({ display_title: 'Reconcile unpublished releases', ...overrides });

describe('release reconciliation sweep', () => {
  it('dispatches nothing while every merged release is published', () => {
    const result = sweep({ releases: delivered });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
    expect(result.summary).not.toContain('needs attention');
  });

  it('dispatches one reconcile run for merged release PRs with no release', () => {
    // The break this guards: a push GitHub never delivered leaves the merged
    // release PR pending with no run to publish it and no failure to notice.
    const result = sweep({ pending: { server: [875], website: [880] }, releases: delivered });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([releaseReconcile]);
    expect(result.stdout).toContain('backend: release PR #875');
    expect(result.stdout).toContain('website: release PR #880');
  });

  it.each([
    { name: 'a queued reconcile run', active: reconcile({ status: 'queued', conclusion: null }) },
    {
      name: "the merge's own push run behind a train lock",
      active: run({ status: 'in_progress', conclusion: null, event: 'push' }),
    },
  ])('waits while $name may still publish', ({ active }) => {
    const result = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [reconcile({ conclusion: 'failure' }), active],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toMatch(/still (queued|in_progress)/u);
  });

  it('leaves a draft alone while a run since the merge is still going', () => {
    // Release Please creates the draft first and moves the label with it, but
    // the sweep reads the two a moment apart; a draft next to a pending label
    // with a live run is that run's release, not a stalled recovery.
    const result = sweep({
      pending: { server: [875] },
      releases: [...delivered, { tag_name: 'v1.2.3', draft: true }],
      releaseRuns: [run({ status: 'in_progress', conclusion: null, event: 'push' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).not.toContain('::error::');
  });

  it('does not retry a reconcile run that failed since the merge', () => {
    // The break this guards: a reconcile run refused by the lifecycle would
    // otherwise be dispatched again every sweep, seventy red runs a day with
    // the sweep itself green.
    const result = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [
        reconcile({ conclusion: 'failure' }),
        run({ conclusion: 'success', event: 'push' }),
      ],
    });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('::error::release-dispatch.yml: the last reconcile run');
    expect(result.stdout).toContain('ended with failure');
  });

  it('is not blocked by a failed re-plan or recovery run of another train', () => {
    const result = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [run({ conclusion: 'failure' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([releaseReconcile]);
  });

  it('stops after green reconcile runs that left the release unpublished', () => {
    // A green reconcile run that published nothing means the lifecycle does
    // not consider the PR pending; dispatching every twenty minutes would keep
    // the sweep green forever, which is the failure this sweep exists to end.
    const once = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [reconcile()],
    });
    expect(once.status, once.stderr).toBe(0);
    expect(once.dispatches).toEqual([releaseReconcile]);
    const twice = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [reconcile(), reconcile({ created_at: '2026-09-28T21:36:00Z' })],
    });
    expect(twice.status).toBe(1);
    expect(twice.dispatches).toEqual([]);
    expect(twice.stdout).toContain('2 reconcile runs since the merge ended green');
  });

  it('leaves a merge younger than the push run lag to its own run', () => {
    // GitHub creates the push run minutes after a busy merge; a sweep in that
    // window would race the run that is about to publish for the train lock.
    const result = sweep({
      pending: { server: [875] },
      releases: delivered,
      mergedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('younger than the push run lag');
  });

  it('leaves an OTA approval younger than the push run lag to its own run', () => {
    const result = sweep({ approvedAt: new Date(Date.now() - 60 * 1000).toISOString() });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });

  it('ignores reconcile runs from before the merge', () => {
    const result = sweep({
      pending: { server: [875] },
      releases: delivered,
      releaseRuns: [reconcile({ conclusion: 'failure', created_at: '2026-09-28T20:45:38Z' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([releaseReconcile]);
  });

  it.each([
    {
      name: 'a draft that manual recovery owns',
      releases: [{ tag_name: 'v1.2.3', draft: true }],
      error: 'v1.2.3 exists as a draft',
    },
    {
      name: 'a published version whose PR still carries the pending label',
      releases: [{ tag_name: 'v1.2.3' }],
      error: 'still carries the pending label',
    },
  ])('fails loudly instead of dispatching against $name', ({ releases, error }) => {
    const result = sweep({ pending: { server: [875] }, releases: [...delivered, ...releases] });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('::error::backend:');
    expect(result.stdout).toContain(error);
  });

  it('refuses to guess between two pending release PRs of one train', () => {
    const result = sweep({ pending: { server: [875, 876] }, releases: delivered });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('::error::backend: release PRs #875, #876');
  });

  it('dispatches the promotion an approved OTA candidate never got', () => {
    // Mobile 1.41.1 on 2026-09-28: the promotion merge produced no run at all.
    // An older run of the previous promotion must not count as its delivery.
    const result = sweep({
      promoteRuns: [run({ created_at: '2026-09-28T17:26:47Z', event: 'push' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([promote]);
    expect(result.stdout).toContain(
      'OTA: mobile-v1.33.1 is approved and no promotion run followed',
    );
  });

  it('does not mistake a staging prerelease for production delivery', () => {
    const result = sweep({ releases: [{ tag_name: 'mobile-v1.33.1', prerelease: true }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([promote]);
  });

  it('leaves a running promotion alone', () => {
    const result = sweep({
      promoteRuns: [run({ status: 'in_progress', conclusion: null, event: 'push' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });

  it('retries a failed promotion once, then asks a human', () => {
    // Moving the channel is idempotent, so one retry absorbs a transient
    // failure; retrying every sweep would only bury the run under copies.
    const once = sweep({ promoteRuns: [run({ conclusion: 'failure', event: 'push' })] });
    expect(once.status, once.stderr).toBe(0);
    expect(once.dispatches).toEqual([promote]);
    expect(once.stdout).toContain('retrying once');
    const twice = sweep({
      promoteRuns: [
        run({ conclusion: 'failure', event: 'workflow_dispatch' }),
        run({ conclusion: 'failure', event: 'push' }),
      ],
    });
    expect(twice.status).toBe(1);
    expect(twice.dispatches).toEqual([]);
    expect(twice.stdout).toContain('::error::OTA: mobile-v1.33.1 is approved but unpublished');
    expect(twice.stdout).toContain('after an automatic retry');
  });

  it.each(['staging', 'missing'] as const)(
    'waits instead of failing while the native runtime is %s',
    (otaRuntime) => {
      const result = sweep({
        otaRuntime,
        promoteRuns: [run({ conclusion: 'failure', event: 'push' })],
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.dispatches).toEqual([]);
      expect(result.stdout).toContain('waits for native production approval of 1.32.0');
    },
  );

  it('counts OTA attempts only after the native runtime reached production', () => {
    const result = sweep({
      promoteRuns: [
        run({
          conclusion: 'failure',
          event: 'workflow_dispatch',
          created_at: '2026-09-28T22:00:00Z',
        }),
        run({ conclusion: 'failure', event: 'push', created_at: '2026-09-28T21:40:00Z' }),
      ],
      nativePromoteRuns: [run({ created_at: '2026-09-28T23:00:00Z' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([promote]);
  });

  it('names a promotion that ended green without publishing the candidate', () => {
    const result = sweep({ promoteRuns: [run({ event: 'push' })] });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('ended green');
  });

  it('treats a draft OTA release as undelivered', () => {
    const result = sweep({ releases: [{ tag_name: 'mobile-v1.33.1', draft: true }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([promote]);
  });

  it('handles both trains and OTA in one sweep', () => {
    const result = sweep({ pending: { mobile: [871] } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([releaseReconcile, promote]);
  });
});

// A Server release can become Main before Mobile classification finishes, leaving no PR to recover.
describe('missing native Staging planning', () => {
  const native = [{ tag_name: 'mobile-v1.33.0' }];
  const replan = 'workflow run release-dispatch.yml --ref main -f mobile-replan=true';
  it('recovers native changes displaced by a subsequent Server release', () => {
    const result = sweep({ ota: false, native: {}, releases: native });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([replan]);
    expect(result.summary).toContain('had no Staging release PR');
  });
  // Rename detection must not hide the removal of an input from the native tree.
  it('recovers a native file moved outside the native tree', () => {
    const result = sweep({ ota: false, native: { rename: true }, releases: native });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it.each([
    { name: 'open native PR', native: { open: true } },
    {
      name: 'unchanged fingerprint',
      native: { path: 'apps/mobile/package.json', compatible: true },
    },
    { name: 'pure OTA source', native: { path: 'apps/mobile/app/session.tsx' } },
    { name: 'stale checkout', native: { oldHead: true } },
    { name: 'Main advancing during classification', native: { mainMoved: true } },
    { name: 'recent Main push', native: { recent: true } },
  ])('waits for $name without dispatching', ({ native: state }) => {
    const result = sweep({ ota: false, native: state, releases: native });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('leaves native draft recovery to its existing publication path', () => {
    const result = sweep({
      ota: false,
      native: {},
      releases: [{ tag_name: 'mobile-v1.33.0', draft: true }],
    });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('waits for a running dispatcher', () => {
    const result = sweep({
      ota: false,
      native: {},
      releases: native,
      releaseRuns: [run({ status: 'in_progress' })],
    });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it.each(['failure', 'success'])(
    'reports a %s replan without a PR instead of looping',
    (conclusion) => {
      const result = sweep({
        ota: false,
        native: {},
        releases: native,
        releaseRuns: [run({ conclusion, display_title: 'replan' })],
      });
      expect(result.status).toBe(1);
      expect(result.dispatches).toEqual([]);
      expect(result.summary).toContain('no native Staging PR exists');
    },
  );
  it('re-evaluates a different Main revision after an older replan', () => {
    const result = sweep({
      ota: false,
      native: {},
      releases: native,
      releaseRuns: [run({ display_title: 'Replan native mobile ' + 'a'.repeat(40) })],
    });
    expect(result.status).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
});

describe('missing Server Staging planning', () => {
  const releases = [{ tag_name: 'v1.2.3' }];
  const replan = 'workflow run release-dispatch.yml --ref main -f backend-replan=true';
  const base = { backend: true, ota: false, releases };
  it('recovers a missing push plan', () => {
    const result = sweep({ ...base, native: { path: 'packages/server/src/example.ts' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it('recovers a release triggered by a server revert', () => {
    const result = sweep({
      ...base,
      native: { path: 'packages/server/src/example.ts' },
      message: 'revert(server): restore previous behavior',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it('recovers a release triggered by a squash body entry', () => {
    const result = sweep({
      ...base,
      native: { path: 'packages/server/src/example.ts' },
      message: 'chore: maintenance\n\nfix(server): correct storage',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it('recovers a release triggered only by a breaking footer', () => {
    const result = sweep({
      ...base,
      native: { path: 'packages/server/src/example.ts' },
      message: 'refactor(server): revise storage\n\nBREAKING CHANGE: storage format changed',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it.each([
    { path: 'apps/mobile/app/example.tsx' },
    { path: 'docs/website/example.md' },
    { path: 'packages/server/src/example.ts', open: true },
    { path: 'packages/server/src/example.ts', oldHead: true },
    { path: 'packages/server/src/example.ts', mainMoved: true },
    { path: 'packages/server/src/example.ts', recent: true },
  ])('does not dispatch for excluded or changing state %j', (native) => {
    const result = sweep({ ...base, native });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('waits for an active dispatcher', () => {
    const result = sweep({
      ...base,
      native: { path: 'packages/server/src/example.ts' },
      releaseRuns: [run({ status: 'queued' })],
    });
    expect(result.dispatches).toEqual([]);
  });
  it.each(['success', 'failure'])('does not loop after a %s plan', (conclusion) => {
    const result = sweep({
      ...base,
      native: { path: 'packages/server/src/example.ts' },
      releaseRuns: [run({ display_title: 'replan', conclusion })],
    });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
  });
});

it('refreshes an existing stale Server release PR after a missed push', () => {
  const result = sweep({
    backend: true,
    ota: false,
    releases: [{ tag_name: 'v1.2.3' }],
    native: { path: 'packages/server/src/example.ts', open: true, stale: true },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.dispatches).toEqual([
    'workflow run release-dispatch.yml --ref main -f backend-replan=true',
  ]);
});
it.each(['queued', 'completed'])('avoids duplicate stale PR refresh for %s planning', (status) => {
  const result = sweep({
    backend: true,
    ota: false,
    releases: [{ tag_name: 'v1.2.3' }],
    native: { path: 'packages/server/src/example.ts', open: true, stale: true },
    releaseRuns: [run({ status, display_title: 'replan' })],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.dispatches).toEqual([]);
});

it('refreshes an existing stale native release PR without creating a Server plan', () => {
  const result = sweep({
    ota: false,
    releases: [{ tag_name: 'mobile-v1.33.0', prerelease: true }],
    native: { open: true, stale: true },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.dispatches).toEqual([
    'workflow run release-dispatch.yml --ref main -f mobile-replan=true',
  ]);
});
it.each([{ recent: true }, { oldHead: true }, { mainMoved: true }])(
  'waits before refreshing stale PRs when Main changes: %j',
  (state) => {
    const result = sweep({
      backend: true,
      ota: false,
      releases: [{ tag_name: 'v1.2.3' }],
      native: { open: true, stale: true, ...state },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  },
);

it('refreshes an existing stale OTA PR through the compatibility-gated OTA workflow', () => {
  const result = sweep({ ota: false, openOta: true, native: { stale: true } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.dispatches).toEqual(['workflow run mobile-ota.yml --ref main']);
});
it('does not repeatedly refresh an OTA PR for the same Main source', () => {
  const result = sweep({ ota: false, openOta: true, native: { stale: true }, otaRuns: [run({})] });
  expect(result.status, result.stderr).toBe(0);
  expect(result.dispatches).toEqual([]);
});

describe('approved Server Production recovery', () => {
  const serverPromote = 'workflow run server-production-promote.yml --ref main';
  const sweepServer = (fixture: Fixture = {}) =>
    sweep({ ota: false, serverPromotion: true, ...fixture });
  it('recovers a missed push while ignoring older promotion runs', () => {
    const result = sweepServer({
      serverPromoteRuns: [run({ created_at: '2026-09-28T17:00:00Z' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([serverPromote]);
  });
  it('waits for the approval push grace period', () => {
    const result = sweepServer({ approvedAt: new Date().toISOString() });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it.each(['queued', 'in_progress'])('waits for a %s attempt', (status) => {
    const result = sweepServer({ serverPromoteRuns: [run({ status, conclusion: null })] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it.each(['failure', 'cancelled'])('retries a completed %s once', (conclusion) => {
    const once = sweepServer({ serverPromoteRuns: [run({ conclusion })] });
    expect(once.status, once.stderr).toBe(0);
    expect(once.dispatches).toEqual([serverPromote]);
    const twice = sweepServer({
      serverPromoteRuns: [run({ conclusion }), run({ conclusion: 'failure' })],
    });
    expect(twice.status).toBe(1);
    expect(twice.dispatches).toEqual([]);
    expect(twice.stdout).toContain('::error::Server: v1.2.3 is approved but unpublished');
  });
  it('reports a green attempt that left the release unpublished', () => {
    const result = sweepServer({ serverPromoteRuns: [run({})] });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('::error::Server: v1.2.3 is approved but unpublished');
  });
  it.each([{ draft: true }, { prerelease: true }])(
    'does not count staging or draft as delivered: %j',
    (release) => {
      const result = sweepServer({ releases: [{ tag_name: 'v1.2.3', ...release }] });
      expect(result.status, result.stderr).toBe(0);
      expect(result.dispatches).toEqual([serverPromote]);
    },
  );
  it('leaves a published Production release alone', () => {
    const result = sweepServer({ releases: [{ tag_name: 'v1.2.3' }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('rejects malformed approval metadata without dispatch', () => {
    const result = sweepServer({ invalidServerPromotion: true });
    expect(result.status).not.toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('recovers Server and OTA independently', () => {
    const result = sweepServer({ ota: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([promote, serverPromote]);
  });
});

describe('approved native Production recovery', () => {
  const nativePromote = 'workflow run mobile-production-promote.yml --ref main';
  const sweepNative = (fixture: Fixture = {}) =>
    sweep({ ota: false, nativePromotion: true, ...fixture });
  it('recovers a missed push', () => {
    const result = sweepNative();
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([nativePromote]);
  });
  it('treats the Staging prerelease as undelivered and production as done', () => {
    expect(
      sweepNative({ releases: [{ tag_name: 'mobile-v1.31.0', prerelease: true }] }).dispatches,
    ).toEqual([nativePromote]);
    expect(sweepNative({ releases: [{ tag_name: 'mobile-v1.31.0' }] }).dispatches).toEqual([]);
  });
  it('retries a failed promotion once, since the upload reuses an existing build', () => {
    const once = sweepNative({ nativePromoteRuns: [run({ conclusion: 'failure' })] });
    expect(once.status, once.stderr).toBe(0);
    expect(once.dispatches).toEqual([nativePromote]);
    const twice = sweepNative({
      nativePromoteRuns: [run({ conclusion: 'failure' }), run({ conclusion: 'failure' })],
    });
    expect(twice.status).toBe(1);
    expect(twice.dispatches).toEqual([]);
    expect(twice.stdout).toContain('::error::Native: mobile-v1.31.0 is approved but unpublished');
  });
});

describe('merged Staging OTA recovery', () => {
  const ota = 'workflow run mobile-ota.yml --ref main';
  const sweepStaging = (fixture: Fixture = {}) =>
    sweep({ ota: false, otaStaging: { version: '1.32.2' }, ...fixture });
  it('stages a merged version that no OTA run followed', () => {
    const result = sweepStaging();
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([ota]);
  });
  it('leaves a staged version alone', () => {
    const result = sweepStaging({ releases: [{ tag_name: 'mobile-v1.32.2', prerelease: true }] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
  it('ignores planning markers and retired runtimes', () => {
    expect(sweepStaging({ otaStaging: { version: '1.32.0' } }).dispatches).toEqual([]);
    expect(sweepStaging({ otaStaging: { version: '1.31.4' } }).dispatches).toEqual([]);
  });
  it('waits for the native runtime to reach Staging', () => {
    const result = sweepStaging({ otaRuntime: 'missing' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('waits for native 1.32.0 to reach Staging');
  });
  it('runs once more, then asks a human', () => {
    const once = sweepStaging({ otaRuns: [run({ conclusion: 'failure' })] });
    expect(once.dispatches).toEqual([ota]);
    const twice = sweepStaging({
      otaRuns: [run({ conclusion: 'failure' }), run({ conclusion: 'success' })],
    });
    expect(twice.status).toBe(1);
    expect(twice.dispatches).toEqual([]);
    expect(twice.stdout).toContain(
      '::error::OTA Staging: mobile-v1.32.2 is merged but unpublished',
    );
  });
  it('waits for an active OTA run', () => {
    const result = sweepStaging({ otaRuns: [run({ status: 'in_progress', conclusion: null })] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });
});

describe('missing website planning', () => {
  const replan = 'workflow run release-dispatch.yml --ref main -f website-replan=true';
  const websiteSweep = (fixture: Fixture = {}) =>
    sweep({ ota: false, website: {}, releases: [{ tag_name: 'website-v0.4.0' }], ...fixture });
  it('recovers releasable website changes after a lost push', () => {
    const result = websiteSweep();
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([replan]);
  });
  it.each(['docs/website/concept.md', 'packages/server/example.ts'])(
    'ignores excluded or unrelated changes: %s',
    (path) => {
      const result = websiteSweep({ website: { path } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.dispatches).toEqual([]);
    },
  );
  it('waits for an active dispatcher', () => {
    expect(
      websiteSweep({ releaseRuns: [run({ status: 'in_progress', conclusion: null })] }).dispatches,
    ).toEqual([]);
  });
  it('reports planning that completed without a PR instead of dispatching forever', () => {
    const result = websiteSweep({ releaseRuns: [run({ display_title: 'replan' })] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('no Website Staging PR exists');
  });
});
