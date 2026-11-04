import { expect, it, vi } from 'vitest';
import { measureBranchReadStage } from './branch-read-diagnostics.js';

it('reports slow stages including failures using only bounded timing fields', async () => {
  let clock = 0;
  const report = vi.fn();
  const value = { owner: 'private-repository' };
  expect(
    await measureBranchReadStage(
      'metadata',
      async () => {
        clock = 2_999;
        return value;
      },
      report,
      () => clock,
    ),
  ).toBe(value);
  expect(report).not.toHaveBeenCalled();
  const failure = new Error('private command output');
  await expect(
    measureBranchReadStage(
      'pr',
      async () => {
        clock += 3_001;
        throw failure;
      },
      report,
      () => clock,
    ),
  ).rejects.toBe(failure);
  expect(report.mock.calls).toEqual([[{ stage: 'pr', elapsedMs: 3_001 }]]);
  expect(JSON.stringify(report.mock.calls)).not.toContain('private');
});
