import { describe, it, expect } from 'vitest';
import { computeQAStatistics, type AnalysisRun, type AnalysisJob } from './qa-statistics.js';
export const run = (overrides: Partial<AnalysisRun> = {}): AnalysisRun => ({
  id: 1,
  run_attempt: 1,
  workflow_id: 10,
  event: 'push',
  head_branch: 'main',
  head_sha: 'abc',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-10-01T00:00:00Z',
  run_started_at: '2026-10-01T00:00:10Z',
  updated_at: '2026-10-01T01:00:00Z',
  html_url: 'https://github.com/a/b/actions/runs/1',
  name: 'CI',
  ...overrides,
});
const job = (id: number, start: number, end: number): AnalysisJob => ({
  id,
  name: 'build',
  conclusion: 'success',
  started_at: `2026-10-01T00:00:${String(start).padStart(2, '0')}Z`,
  completed_at: `2026-10-01T00:00:${String(end).padStart(2, '0')}Z`,
  html_url: 'https://github.com/a/b/actions/jobs/' + id,
});
describe('QA statistics', () => {
  it('uses overlapping job wall time, not sums or the mutable run updated_at', () => {
    const result = computeQAStatistics(
      [run()],
      new Map(),
      new Map([[1, [job(1, 10, 40), job(2, 20, 50)]]]),
      'main',
      [],
    )[0]!;
    expect(result.wallTime).toMatchObject({
      n: 1,
      meanSeconds: 40,
      medianSeconds: 40,
      p95Seconds: 40,
    });
    expect(result.initialQueueTime.meanSeconds).toBe(10);
  });
  it('separates first-attempt failures, eventual success and unknown queue times', () => {
    const result = computeQAStatistics(
      [run({ run_attempt: 2 })],
      new Map([[1, run({ conclusion: 'failure' })]]),
      new Map([[1, [job(1, 10, 40)]]]),
      'main',
      [],
    )[0]!;
    expect(result.firstAttempt).toMatchObject({ eligible: 1, successRate: 0 });
    expect(result.outcomes).toEqual({ success: 1 });
    expect(result.additionalAttempts).toBe(1);
    expect(result.initialQueueTime.n).toBe(0);
  });
  it('does not label PR builds as releases or invent metrics for incomplete jobs', () => {
    const result = computeQAStatistics(
      [run({ event: 'pull_request' })],
      new Map(),
      new Map(),
      'main',
      [10],
    )[0]!;
    expect(result.group).toBe('pr-ci:10');
    expect(result.wallTime.meanSeconds).toBeNull();
    expect(result.excludedDurations).toBe(1);
  });
});
it('excludes skipped jobs from wall-time calculation without excluding completed jobs', () => {
  const result = computeQAStatistics(
    [run()],
    new Map(),
    new Map([
      [
        1,
        [
          job(1, 10, 40),
          { ...job(2, 0, 0), conclusion: 'skipped', started_at: null, completed_at: null },
        ],
      ],
    ]),
    'main',
    [],
  )[0]!;
  expect(result.wallTime.meanSeconds).toBe(30);
  expect(result.wallTime.n).toBe(1);
});
