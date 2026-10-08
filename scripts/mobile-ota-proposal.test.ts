import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it, vi } from 'vitest';
import type { GitHub } from 'release-please';
import type { Commit } from 'release-please/build/src/commit.js';
import type { PullRequest } from 'release-please/build/src/pull-request.js';
import type { Update } from 'release-please/build/src/update.js';
import {
  createOtaManifest,
  otaConfigPath,
  otaManifestPath,
  otaReleasePlan,
  otaSourcePath,
  otaVersionPath,
} from './mobile-ota-proposal.mjs';

it('allocates patches from the latest staged release even before production catches up', () => {
  expect(
    otaReleasePlan('1.52.0', [
      { tag_name: 'mobile-v1.52.0', draft: false },
      { tag_name: 'mobile-v1.52.3', draft: false },
      { tag_name: 'mobile-v1.52.4', draft: true },
      { tag_name: 'mobile-v1.51.99', draft: false },
    ]),
  ).toEqual({ baseline: 'mobile-v1.52.3', version: '1.52.4' });
});

it('starts a fresh runtime at patch one and refuses an unpublished native runtime', () => {
  expect(
    otaReleasePlan('1.53.0', [
      { tag_name: 'mobile-v1.52.99', draft: false },
      { tag_name: 'mobile-v1.53.0', draft: false },
    ]).version,
  ).toBe('1.53.1');
  expect(() => otaReleasePlan('1.53.0', [])).toThrow('not published');
  expect(() => otaReleasePlan('1.53.1', [])).toThrow('native');
});

it('includes shared application sources while excluding promotion and version metadata', () => {
  for (const path of [
    'apps/mobile/app/example-screen.tsx',
    'packages/mobile/src/example.ts',
    'packages/events/src/index.ts',
    'package-lock.json',
  ])
    expect(otaSourcePath(path)).toBe(true);
  for (const path of [
    otaVersionPath,
    'apps/mobile/ota/CHANGELOG.md',
    'apps/mobile/ota-promotion.json',
    'apps/mobile/version.txt',
    'packages/server/src/index.ts',
  ])
    expect(otaSourcePath(path)).toBe(false);
});

async function* rows<T>(items: T[]) {
  yield* items;
}

it.each([
  { version: '1.52.4', pendingVersion: undefined, blocked: false },
  { version: '1.53.1', pendingVersion: '1.52.7', blocked: false },
  { version: '1.53.2', pendingVersion: '1.53.1', blocked: true },
  { version: '1.53.1', pendingVersion: '1.54.1', blocked: true },
])(
  'plans OTA $version with pending $pendingVersion through the real SDK (blocked: $blocked)',
  async ({ version, pendingVersion, blocked }) => {
    const baseline = 'b'.repeat(40);
    const commits: Commit[] = [
      {
        sha: 'c'.repeat(40),
        message: 'fix(mobile): render staged messages',
        files: ['packages/mobile/src/example-messages.ts'],
      },
      {
        sha: 'd'.repeat(40),
        message: 'feat(server): unrelated deployment',
        files: ['packages/server/src/server.ts'],
      },
      {
        sha: baseline,
        message: 'fix(mobile): already staged change',
        files: ['apps/mobile/app/example-screen.tsx'],
      },
      {
        sha: 'e'.repeat(40),
        message: 'fix(mobile): historical change',
        files: ['apps/mobile/app/example-screen.tsx'],
      },
    ];
    const updates: Update[] = [];
    const createPullRequest = vi.fn(
      (pr: PullRequest, _target: string, _message: string, changes: Update[]) => {
        updates.push(...changes);
        return Promise.resolve({ ...pr, number: 123 });
      },
    );
    const { PullRequestBody } = await import('release-please/build/src/util/pull-request-body.js');
    const { Version } = await import('release-please/build/src/version.js');
    const pendingMarker = pendingVersion ?? '1.52.7';
    const pending = {
      number: 1157,
      title: `chore(main): release staging OTA ${pendingMarker}`,
      headBranchName: 'release-please--branches--main--components--mobile-ota',
      labels: ['autorelease: pending-mobile-ota'],
      body: new PullRequestBody([
        {
          version: Version.parse(pendingMarker),
          notes: `## [${pendingMarker}](https://example.com/compare/previous...next)`,
        },
      ]).toString(),
    };
    const github = {
      repository: { owner: 'example', repo: 'verity', defaultBranch: 'main' },
      getFileJson: (path: string) =>
        Promise.resolve(JSON.parse(readFileSync(path, 'utf8')) as unknown),
      releaseIterator: () => rows([]),
      tagIterator: () => rows([]),
      mergeCommitIterator: () => rows(commits),
      pullRequestIterator: (_branch: string, status: string) =>
        rows(status === 'MERGED' && pendingVersion !== undefined ? [pending] : []),
      createPullRequest,
    } as unknown as GitHub;
    const manifest = await createOtaManifest(github, baseline, version);
    const prs = await manifest.createPullRequests();
    if (blocked) {
      expect(prs).toEqual([]);
      expect(createPullRequest).not.toHaveBeenCalled();
      return;
    }
    expect(prs).toHaveLength(1);
    expect(prs[0]?.headBranchName).toBe('release-please--branches--main--components--mobile-ota');
    expect(prs[0]?.title).toBe(`chore(release): staging mobile OTA ${version}`);
    expect(prs[0]?.body).toContain('render staged messages');
    const parts = version.split('.').map(Number);
    const previous = `${parts[0]}.${parts[1]}.${Number(parts[2]) - 1}`;
    expect(prs[0]?.body).toContain(`compare/mobile-v${previous}...mobile-v${version}`);
    expect(prs[0]?.body).not.toContain('unrelated deployment');
    expect(prs[0]?.body).not.toContain('already staged change');
    expect(prs[0]?.body).not.toContain('historical change');
    expect(createPullRequest.mock.calls[0]?.[0].labels).toContain(
      'autorelease: pending-mobile-ota',
    );
    const versionUpdate = updates.find((update) => update.path === otaVersionPath);
    expect(versionUpdate?.updater.updateContent(readFileSync(otaVersionPath, 'utf8'))).toBe(
      `${version}\n`,
    );
    expect(updates.map((update) => update.path).sort()).toEqual(
      [otaManifestPath, 'apps/mobile/ota/CHANGELOG.md', otaVersionPath].sort(),
    );
    expect(
      JSON.parse(readFileSync(otaConfigPath, 'utf8')) as {
        packages: Record<string, { 'skip-github-release': boolean }>;
      },
    ).toHaveProperty(['packages', '.', 'skip-github-release'], true);
  },
);

function detectFixture(
  options: {
    nativeVersion?: string;
    released?: boolean;
    complete?: boolean;
    deferred?: boolean;
    event?: string;
    tagCommit?: string;
    reviewedVersion?: string;
    production?: boolean;
    forged?: boolean;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), 'verity-ota-proposal-'));
  mkdirSync(join(cwd, 'apps/mobile/ota'), { recursive: true });
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, otaVersionPath), '1.52.4\n');
  writeFileSync(join(cwd, 'apps/mobile/version.txt'), `${options.nativeVersion ?? '1.52.0'}\n`);
  writeFileSync(join(cwd, otaManifestPath), JSON.stringify({ '.': '1.52.4' }));
  const commit = 'c'.repeat(40);
  const pr = {
    number: 12,
    merged_at: '2026-10-04',
    base: { ref: 'main' },
    head: {
      ref: options.forged
        ? 'feature/manual'
        : 'release-please--branches--main--components--mobile-ota',
      sha: 'a'.repeat(40),
    },
    user: { login: 'github-actions[bot]' },
    labels: options.complete
      ? [{ name: 'autorelease: tagged-mobile-ota' }]
      : [{ name: 'autorelease: pending-mobile-ota' }],
  };
  if (options.deferred) pr.labels.push({ name: 'autorelease: deferred-mobile-ota' });
  const gh = `#!${process.execPath}
const args=process.argv.slice(2);
const endpoint=args.at(-1);
let response;
if (args[0] === 'label' || args[0] === 'pr') response={};
else if (endpoint.includes('/releases?')) response=[[${options.released ? JSON.stringify({ tag_name: 'mobile-v1.52.4', draft: false, prerelease: !options.production }) : ''}]];
else if (endpoint.endsWith('/pulls')) response=[${JSON.stringify(pr)}];
else if (endpoint.includes('/contents/')) response={content: ${JSON.stringify(Buffer.from(options.reviewedVersion ?? '1.52.4').toString('base64'))}};
else throw new Error('Unexpected gh invocation: '+args.join(' '));
process.stdout.write(JSON.stringify(response));
`;
  const git = `#!${process.execPath}
process.stdout.write(process.argv[2] === 'log' ? '${commit}' : '${options.tagCommit ?? commit}');
`;
  writeFileSync(join(cwd, 'bin/gh'), gh);
  chmodSync(join(cwd, 'bin/gh'), 0o755);
  writeFileSync(join(cwd, 'bin/git'), git);
  chmodSync(join(cwd, 'bin/git'), 0o755);
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  try {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/mobile-ota-proposal.mjs'), 'detect'],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
          GITHUB_REPOSITORY: 'example/verity',
          GITHUB_OUTPUT: output,
          GITHUB_EVENT_NAME: options.event ?? 'push',
        },
      },
    );
    return { ...result, output: readFileSync(output, 'utf8'), commit };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

it('publishes from the original merged release source when later main commits exist', () => {
  const result = detectFixture();
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toContain(`mode=stage\nversion=1.52.4\ncommit=${result.commit}\n`);
});

it('retries an incomplete promotion proposal even when its Staging prerelease already exists', () => {
  const result = detectFixture({ released: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toContain('mode=stage');
  const completed = detectFixture({ released: true, complete: true });
  expect(completed.status, completed.stderr).toBe(0);
  expect(completed.output).toBe('mode=plan\n');
});

it('resumes a deferred proposal after Staging completion and delivery dispatch', () => {
  const deferred = detectFixture({
    released: true,
    complete: true,
    deferred: true,
    event: 'workflow_dispatch',
  });
  expect(deferred.status, deferred.stderr).toBe(0);
  expect(deferred.output).toContain('mode=stage');
  const nextMerge = detectFixture({ released: true, complete: true, deferred: true });
  expect(nextMerge.status, nextMerge.stderr).toBe(0);
  expect(nextMerge.output).toBe('mode=plan\n');
  const recovered = detectFixture({ released: true, complete: true });
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(recovered.output).toBe('mode=plan\n');
});

it('recovers a missed completion label after production has already delivered the version', () => {
  const result = detectFixture({ released: true, production: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toBe('mode=plan\n');
});

it('rejects a mismatched public tag or a changed release PR version', () => {
  expect(
    detectFixture({ released: true, complete: true, tagCommit: 'd'.repeat(40) }).status,
  ).not.toBe(0);
  expect(detectFixture({ reviewedVersion: '1.52.3' }).status).not.toBe(0);
  expect(detectFixture({ forged: true }).status).not.toBe(0);
});

it('publishes only merged fixed versions under an independent staging lock', () => {
  const workflow = parse(readFileSync('.github/workflows/mobile-ota.yml', 'utf8')) as {
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: {
      update: {
        steps: Array<{ name?: string; run?: string; if?: string; env?: Record<string, string> }>;
      };
    };
  };
  const promotion = parse(readFileSync('.github/workflows/mobile-ota-promote.yml', 'utf8'));
  expect(workflow.concurrency.group).not.toBe(promotion.concurrency.group);
  expect(workflow.concurrency.group).not.toBe('release-mobile');
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  const steps = workflow.jobs.update.steps;
  const stage = steps.find((step) => step.run?.includes('mobile-ota-release.ts stage'));
  expect(stage?.if).toContain("steps.intent.outputs.mode == 'stage'");
  expect(stage?.run).toContain('steps.intent.outputs.version');
  expect((stage as { id?: string })?.id).toBe('stage');
  expect(
    steps.find((step) => step.run?.includes('mobile-ota-proposal.mjs complete'))?.run,
  ).toContain('steps.stage.outputs.deferred');
  expect(stage?.env?.OTA_SOURCE_SHA).toContain('steps.intent.outputs.commit');
  const refresh = steps.findIndex((step) => step.run?.includes('git fetch origin main'));
  const ownership = steps.findIndex(
    (step) => step.name === 'Detect commits owned by another mobile workflow',
  );
  const intent = steps.findIndex((step) => step.run?.includes('mobile-ota-proposal.mjs detect'));
  expect(refresh).toBeGreaterThan(ownership);
  expect(intent).toBeGreaterThan(refresh);
  const source = steps.findIndex(
    (step) =>
      step.run?.includes('git checkout --detach') && step.run.includes('intent.outputs.commit'),
  );
  expect(source).toBeGreaterThan(intent);
  expect(source).toBeLessThan(steps.findIndex((step) => step.run === 'npm ci'));
  const native = JSON.parse(readFileSync('release-please-config.mobile.json', 'utf8')) as {
    packages: Record<string, { 'exclude-paths': string[] }>;
  };
  expect(native.packages['apps/mobile']?.['exclude-paths']).toContain('apps/mobile/ota');
});

it('plans the new native line instead of replaying an unfinished obsolete OTA release', () => {
  const result = detectFixture({ nativeVersion: '1.53.0' });
  expect(result.status).toBe(0);
  expect(result.output).toBe('mode=plan\n');
});
