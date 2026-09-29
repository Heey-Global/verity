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
  releases?: { tag_name: string; draft?: boolean }[];
  releaseRuns?: Run[];
  promoteRuns?: Run[];
  ota?: boolean;
};

function sweep(fixture: Fixture) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-reconcile-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgSign', 'false');
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
      JSON.stringify({ schema: 1, version: '1.33.1', tag: 'mobile-v1.33.1' }),
    );
  }
  git('add', '.');
  const commitDate = fixture.approvedAt ?? approvedAt;
  execFileSync('git', ['commit', '-qm', 'chore(mobile): promote OTA 1.33.1'], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: commitDate, GIT_COMMITTER_DATE: commitDate },
  });
  mkdirSync(join(cwd, 'bin'));
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
if (joined.includes('/releases?')) {
  process.stdout.write((fixture.releases ?? []).map((r) => JSON.stringify({ tag_name: r.tag_name, draft: !!r.draft, prerelease: false })).join('\\n') + '\\n');
} else if (joined.includes('/pulls?')) {
  const rows = [];
  for (const [component, numbers] of Object.entries(fixture.pending ?? {})) for (const number of numbers) rows.push(pr(component, number));
  rows.push({ ...pr('server', 900), labels: ['autorelease: tagged'] }, { ...pr('server', 901), merged_at: null });
  process.stdout.write(rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
} else if (joined.includes('/actions/workflows/release-dispatch.yml/runs?')) {
  const runs = (fixture.releaseRuns ?? []).map((run, index) => ({ ...run, html_url: 'https://runs.invalid/release/' + index }));
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
    expect(result.summary).toContain('nothing to reconcile');
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

  it('leaves a running promotion alone', () => {
    const result = sweep({
      promoteRuns: [run({ status: 'in_progress', conclusion: null, event: 'push' })],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.dispatches).toEqual([]);
  });

  it('does not retry a promotion that ran and failed', () => {
    // A failed promotion is a red run a human already has to read; retrying it
    // every sweep would only bury that run under identical failures.
    const result = sweep({
      promoteRuns: [run({ conclusion: 'failure', event: 'push' })],
    });
    expect(result.status).toBe(1);
    expect(result.dispatches).toEqual([]);
    expect(result.stdout).toContain('::error::OTA: mobile-v1.33.1 is approved but unpublished');
    expect(result.stdout).toContain('ended with failure');
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
