import { expect, it, vi } from 'vitest';
import { createGitBranchService } from './branches.js';

it('retains the shared ref after a scoped checkout reset', async () => {
  const sha = 'f'.repeat(40);
  const git = vi.fn(async (args: readonly string[]) => {
    if (args.includes('--abbrev-ref') || args.includes('symbolic-ref')) return 'feat/status';
    if (args.includes('rev-parse')) return sha;
    return '';
  });
  const branches = createGitBranchService({ git });

  expect(
    await branches.resetToMergedBase('/wt', { expectedHead: { branch: 'feat/status', sha } }),
  ).toEqual({ base: 'main' });

  const calls = git.mock.calls.map(([args]) => args);
  expect(calls.some((args) => args.includes('checkout'))).toBe(true);
  expect(calls.some((args) => args.includes('update-ref'))).toBe(false);
});
