import { writeSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  candidate: {
    schema: 1,
    artifact: undefined as { id: number; sha256: string } | undefined,
    product: 'mobile-native',
    version: '2.0.0',
    source: 'a'.repeat(40),
    appId: '123',
    buildId: 'approved-build',
    buildNumber: '12',
    releasePr: 42,
  },
  recorded: undefined as Record<string, unknown> | undefined,
  evidenceMissing: false,
  evidenceBranchMissing: false,
  evidenceWriteFailure: false,
  evidenceFailure: false,
  legacyEvidence: true,
  expired: false,
  missing: false,
  replacementExpired: false,
  apiFailure: false,
  prerelease: true,
  same: false,
  merged: false,
  deleted: false,
  calls: [] as { command: string; args: string[] }[],
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: vi.fn((path: string) =>
      path.endsWith('output.json')
        ? fs.readFileSync(path, 'utf8')
        : JSON.stringify(fixture.candidate),
    ),
    writeFileSync: vi.fn(),
  };
});
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((command: string, args: string[], options?: { stdio?: unknown[] }) => {
    fixture.calls.push({ command, args });
    if (command === 'git') {
      if (args[0] === 'ls-remote' && fixture.deleted) return '';
      if (args[0] === 'ls-remote')
        return 'b'.repeat(40) + '\trefs/heads/automation/promote-mobile-production';
      if (args[0] === 'diff' || args[0] === 'ls-tree') return 'releases/mobile-production.json';
      if (args[0] === 'show')
        return JSON.stringify({
          ...fixture.candidate,
          buildId: fixture.same ? 'approved-build' : 'previous-build',
        });
      return '';
    }
    if (args[0] === 'release')
      return args[1] === 'view'
        ? JSON.stringify({
            assets: fixture.legacyEvidence ? [{ name: 'production-candidate.json' }] : [],
            isPrerelease: fixture.prerelease,
          })
        : JSON.stringify(fixture.recorded ?? fixture.candidate);
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged'))
      return fixture.merged
        ? JSON.stringify([
            {
              number: 7,
              headRefOid: 'b'.repeat(40),
              author: { login: 'github-actions[bot]' },
              baseRefName: 'main',
            },
          ])
        : '[]';
    if (args[0] === 'pr')
      return args[1] === 'list'
        ? args.includes('author')
          ? '[{"author":{"login":"github-actions[bot]"}}]'
          : '[{"number":7}]'
        : '';
    if (args[0] === 'workflow') return '';
    const endpoint = args.find((arg) => arg.startsWith('repos/'));
    if (endpoint?.includes('/actions/artifacts/')) {
      if (fixture.apiFailure || (fixture.missing && endpoint.endsWith('/1')))
        throw Object.assign(new Error('Artifact API failure'), {
          stderr: fixture.apiFailure ? 'HTTP 403' : 'HTTP 404',
        });
      return JSON.stringify({
        expired: endpoint.endsWith('/1') ? fixture.expired : fixture.replacementExpired,
      });
    }
    if (endpoint?.endsWith('/releases?per_page=100')) {
      writeSync(
        options!.stdio![1] as number,
        JSON.stringify([
          [
            {
              tag_name: 'mobile-v2.0.0',
              body: 'New native features',
              draft: true,
              prerelease: false,
            },
          ],
        ]),
      );
      return '';
    }
    if (endpoint?.includes('/contents/releases/native-production/')) {
      if (args.includes('PUT') && fixture.evidenceWriteFailure)
        throw new Error('Evidence write conflict');
      if (!args.includes('PUT') && (fixture.evidenceMissing || fixture.evidenceFailure))
        throw Object.assign(new Error('Evidence unavailable'), {
          stderr: fixture.evidenceFailure ? 'HTTP 403' : 'HTTP 404',
        });
      return JSON.stringify({
        content: Buffer.from(JSON.stringify(fixture.recorded ?? fixture.candidate)).toString(
          'base64',
        ),
        sha: 'e'.repeat(40),
      });
    }
    if (endpoint?.includes('/contents/'))
      return JSON.stringify({
        content: Buffer.from(JSON.stringify(fixture.recorded ?? fixture.candidate)).toString(
          'base64',
        ),
      });
    if (endpoint?.endsWith('/git/refs') && args.includes('POST')) return '{}';
    if (
      endpoint?.endsWith('/heads/automation/mobile-production-evidence') &&
      fixture.evidenceBranchMissing
    )
      throw Object.assign(new Error('Missing branch'), { stderr: 'HTTP 404' });
    if (endpoint?.endsWith('/heads/main'))
      return JSON.stringify({ object: { sha: 'c'.repeat(40) } });
    if (endpoint?.includes('/git/ref/heads/'))
      return JSON.stringify({ object: { sha: 'd'.repeat(40) } });
    if (endpoint?.includes('/reviews?')) return '[[]]';
    if (args.includes('graphql'))
      return JSON.stringify({
        data: { createCommitOnBranch: { commit: { signature: { isValid: true } } } },
      });
    throw new Error('Unhandled proposal call ' + args.join(' '));
  }),
}));
import { writeFileSync } from 'node:fs';
import { propose } from './production-promotion.js';
afterEach(() => {
  vi.clearAllMocks();
  fixture.calls = [];
  fixture.same = false;
  fixture.merged = false;
  fixture.deleted = false;
  fixture.candidate.schema = 1;
  fixture.candidate.artifact = undefined;
  fixture.candidate.buildNumber = '12';
  fixture.recorded = undefined;
  fixture.evidenceMissing = false;
  fixture.evidenceBranchMissing = false;
  fixture.evidenceWriteFailure = false;
  fixture.evidenceFailure = false;
  fixture.legacyEvidence = true;
  fixture.expired = false;
  fixture.missing = false;
  fixture.replacementExpired = false;
  fixture.apiFailure = false;
  fixture.prerelease = true;
  vi.unstubAllEnvs();
});
describe('rolling production proposals', () => {
  it('bases a new signed candidate on current main with a lease on the old branch', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    propose('candidate.json');
    const reset = fixture.calls.findIndex(
      (call) => call.command === 'git' && call.args[0] === 'push',
    );
    expect(fixture.calls[reset]?.args).toEqual([
      'push',
      '--force-with-lease=refs/heads/automation/promote-mobile-production:' + 'b'.repeat(40),
      'origin',
      'c'.repeat(40) + ':refs/heads/automation/promote-mobile-production',
    ]);
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('server-production-pr.md'),
      expect.stringContaining('New native features'),
    );
    const signed = fixture.calls.findIndex((call) => call.args.includes('graphql'));
    expect(signed).toBeGreaterThan(reset);
    expect(fixture.calls[signed]?.args).toContain('expected=' + 'c'.repeat(40));
  });
  it.each([false, true])('recovers a merged approval when branch deletion is %s', (deleted) => {
    fixture.deleted = deleted;
    fixture.same = true;
    fixture.merged = true;
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    propose('candidate.json');
    expect(
      fixture.calls.some(
        (call) => call.args[0] === 'pr' && ['create', 'edit'].includes(call.args[1]!),
      ),
    ).toBe(false);
    expect(fixture.calls.some((call) => call.args.includes('graphql'))).toBe(false);
    expect(
      fixture.calls.some((call) =>
        call.args.includes('ref=refs/heads/automation/promote-mobile-production'),
      ),
    ).toBe(false);
    expect(fixture.calls.some((call) => call.args[0] === 'workflow')).toBe(false);
  });
  it('preserves the exact head when retrying the same recorded candidate', () => {
    fixture.same = true;
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    propose('candidate.json');
    expect(fixture.calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(
      false,
    );
    expect(fixture.calls.some((call) => call.args.includes('graphql'))).toBe(false);
  });
});

function replacement() {
  vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
  fixture.candidate.schema = 2;
  fixture.candidate.buildNumber = '13';
  fixture.candidate.artifact = { id: 2, sha256: 'b'.repeat(64) };
  fixture.recorded = {
    ...fixture.candidate,
    buildNumber: '12',
    artifact: { id: 1, sha256: 'c'.repeat(64) },
  };
}
describe('archive expiry recovery', () => {
  it('retains an available archive on a build retry', () => {
    replacement();
    fixture.merged = true;
    propose('candidate.json');
    expect(
      fixture.calls.some((call) => call.args[0] === 'release' && call.args[1] === 'upload'),
    ).toBe(false);
    expect(
      fixture.calls.some(
        (call) => call.args[0] === 'pr' && ['create', 'edit'].includes(call.args[1]!),
      ),
    ).toBe(false);
  });
  it.each(['expired', 'deleted'])(
    'replaces an unavailable archive and requires a fresh promotion head (%s)',
    (state) => {
      replacement();
      fixture.expired = state === 'expired';
      fixture.missing = state === 'deleted';
      fixture.merged = true;
      propose('candidate.json');
      const upload = fixture.calls.findIndex(
        (call) =>
          call.args.includes('PUT') &&
          call.args.some((arg) => arg.includes('/contents/releases/native-production/')),
      );
      expect(upload).toBeGreaterThanOrEqual(0);
      expect(fixture.calls[upload]!.args).toContain('sha=' + 'e'.repeat(40));
      const commit = fixture.calls.findIndex((call) => call.args.includes('graphql'));
      expect(commit).toBeGreaterThan(upload);
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('production-candidate.json'),
        JSON.stringify(fixture.candidate, null, 2) + '\n',
      );
      expect(fixture.calls.some((call) => call.args[0] === 'pr' && call.args[1] === 'edit')).toBe(
        true,
      );
    },
  );
  it.each(['published', 'api-failure', 'replacement-expired', 'different-source'])(
    'never replaces evidence when recovery is unsafe (%s)',
    (state) => {
      replacement();
      fixture.expired = true;
      if (state === 'published') fixture.prerelease = false;
      if (state === 'api-failure') fixture.apiFailure = true;
      if (state === 'replacement-expired') fixture.replacementExpired = true;
      if (state === 'different-source') fixture.recorded!.source = 'd'.repeat(40);
      expect(() => propose('candidate.json')).toThrow();
      expect(
        fixture.calls.some((call) => call.args[0] === 'release' && call.args[1] === 'upload'),
      ).toBe(false);
      expect(fixture.calls.some((call) => call.args.includes('graphql'))).toBe(false);
    },
  );
});

// Publishing Staging locks its assets before the independent production finalizer runs.
describe('immutable staging release evidence', () => {
  it.each([false, true])(
    'records native evidence without modifying release assets (legacy: %s)',
    (legacy) => {
      vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
      fixture.evidenceMissing = true;
      fixture.legacyEvidence = legacy;
      propose('candidate.json');
      const record = fixture.calls.findIndex(
        (call) =>
          call.args.includes('PUT') &&
          call.args.some((arg) => arg.includes('/contents/releases/native-production/')),
      );
      expect(record).toBeGreaterThanOrEqual(0);
      expect(fixture.calls[record]!.args).toContain('branch=automation/mobile-production-evidence');
      expect(
        fixture.calls.some((call) => call.args[0] === 'release' && call.args[1] === 'upload'),
      ).toBe(false);
      expect(fixture.calls.findIndex((call) => call.args.includes('graphql'))).toBeGreaterThan(
        record,
      );
    },
  );
  it('creates the evidence branch before its first record', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    fixture.evidenceMissing = true;
    fixture.evidenceBranchMissing = true;
    fixture.legacyEvidence = false;
    propose('candidate.json');
    const created = fixture.calls.findIndex((call) =>
      call.args.includes('ref=refs/heads/automation/mobile-production-evidence'),
    );
    const recorded = fixture.calls.findIndex((call) => call.args.includes('PUT'));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(recorded).toBeGreaterThan(created);
  });
  it('does not change the promotion when recording evidence conflicts', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    fixture.evidenceMissing = true;
    fixture.evidenceWriteFailure = true;
    expect(() => propose('candidate.json')).toThrow('Evidence write conflict');
    expect(
      fixture.calls.some(
        (call) =>
          call.args.includes('graphql') || (call.command === 'git' && call.args[0] === 'push'),
      ),
    ).toBe(false);
  });
  it('fails closed when evidence cannot be read', () => {
    vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
    fixture.evidenceFailure = true;
    expect(() => propose('candidate.json')).toThrow();
    expect(
      fixture.calls.some((call) => call.args.includes('PUT') || call.args.includes('graphql')),
    ).toBe(false);
  });
});
