import { writeSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  candidate: {
    schema: 1,
    product: 'mobile-native',
    version: '2.0.0',
    source: 'a'.repeat(40),
    appId: '123',
    buildId: 'approved-build',
    buildNumber: '12',
    releasePr: 42,
  },
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
        ? JSON.stringify({ assets: [{ name: 'production-candidate.json' }] })
        : JSON.stringify(fixture.candidate);
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
    if (endpoint?.includes('/contents/'))
      return JSON.stringify({
        content: Buffer.from(JSON.stringify(fixture.candidate)).toString('base64'),
      });
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
  fixture.calls = [];
  fixture.same = false;
  fixture.merged = false;
  fixture.deleted = false;
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
