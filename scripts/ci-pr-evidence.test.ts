import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { eligibleRun, reusePrEvidence, sameContext } from './ci-pr-evidence.mjs';

const context = {
  version: 1,
  repository: 'owner/repo',
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  tree: 'c'.repeat(40),
};
const run = {
  id: 12,
  run_attempt: 1,
  repository: { full_name: context.repository },
  head_sha: context.head,
  path: '.github/workflows/ci.yml',
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
};

describe('duplicate PR CI evidence', () => {
  async function check(
    options: {
      proof?: typeof context;
      runOverride?: object;
      gate?: string;
      fail?: boolean;
      rerun?: boolean;
    } = {},
  ) {
    let queries = 0;
    return reusePrEvidence({
      context,
      currentId: 20,
      artifact: async () => options.proof ?? context,
      api: async (endpoint) => {
        if (options.fail) throw new Error('API unavailable');
        if (endpoint.includes('?head_sha=')) return { workflow_runs: [run] };
        if (endpoint.includes('/jobs?'))
          return { jobs: [{ name: 'ci-checks', conclusion: options.gate ?? 'success' }] };
        return {
          ...run,
          ...options.runOverride,
          ...(options.rerun && ++queries > 1 ? { run_attempt: 2 } : {}),
        };
      },
    });
  }
  it('reuses only a completed canonical required gate', async () => {
    expect(await check()).toBe(true);
    expect(await check({ gate: 'failure' })).toBe(false);
    expect(await check({ gate: 'skipped' })).toBe(false);
    expect(await check({ runOverride: { conclusion: 'failure' } })).toBe(false);
    expect(await check({ runOverride: { conclusion: 'cancelled' } })).toBe(false);
  });
  it.each(['head', 'base', 'tree', 'repository'])('does not reuse a different %s', async (key) => {
    expect(sameContext(context, { ...context, [key]: 'different' })).toBe(false);
    expect(await check({ proof: { ...context, [key]: 'different' } })).toBe(false);
  });
  it('rejects newer/current runs and manual diagnostics', () => {
    expect(eligibleRun(run, context, 12)).toBe(false);
    expect(eligibleRun({ ...run, id: 21 }, context, 20)).toBe(false);
    expect(eligibleRun({ ...run, event: 'workflow_dispatch' }, context, 20)).toBe(false);
    expect(eligibleRun({ ...run, path: '.github/workflows/other.yml' }, context, 20)).toBe(false);
  });
  it('does not keep an old success when its attempt changes', async () => {
    expect(await check({ rerun: true })).toBe(false);
  });
  it('propagates API failure to the CLI full-check fallback', async () => {
    await expect(check({ fail: true })).rejects.toThrow('API unavailable');
  });
  it('waits for the older owner rather than starting a second suite', async () => {
    let completed = false;
    expect(
      await reusePrEvidence({
        context,
        currentId: 20,
        artifact: async () => context,
        api: async (endpoint) =>
          endpoint.includes('?head_sha=')
            ? { workflow_runs: [run] }
            : endpoint.includes('/jobs?')
              ? { jobs: [{ name: 'ci-checks', conclusion: 'success' }] }
              : {
                  ...run,
                  status: completed ? 'completed' : 'in_progress',
                  conclusion: completed ? 'success' : null,
                },
        wait: async ({ initial, query }) => {
          expect(initial).toBe('in_progress/none');
          completed = true;
          return query(100);
        },
      }),
    ).toBe(true);
  });
  it('allows the older context upload to finish when events arrive together', async () => {
    let uploads = 0;
    let pauses = 0;
    expect(
      await reusePrEvidence({
        context,
        currentId: 20,
        artifact: async () => {
          if (++uploads === 1) throw new Error('Not uploaded yet');
          return context;
        },
        pause: async () => {
          pauses += 1;
        },
        api: async (endpoint) =>
          endpoint.includes('?head_sha=')
            ? { workflow_runs: [{ ...run, status: 'in_progress' }] }
            : endpoint.includes('/jobs?')
              ? { jobs: [{ name: 'ci-checks', conclusion: 'success' }] }
              : run,
      }),
    ).toBe(true);
    expect(pauses).toBe(1);
  });
  it('falls back when an identical older run exceeds the wait budget', async () => {
    expect(
      await reusePrEvidence({
        context,
        currentId: 20,
        artifact: async () => context,
        api: async (endpoint) =>
          endpoint.includes('?head_sha=')
            ? { workflow_runs: [run] }
            : { ...run, status: 'in_progress', conclusion: null },
        wait: async () => 'timeout/none',
      }),
    ).toBe(false);
  });
  it('keeps title validation and publishes context before reuse; only proven reuse skips routing', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      on: { pull_request: { types: string[] } };
      concurrency: { group: string };
      jobs: {
        changes: {
          'timeout-minutes': number;
          steps: { name?: string; id?: string; env?: Record<string, string>; run?: string }[];
        };
      };
    };
    const steps = workflow.jobs.changes.steps;
    const title = steps.findIndex(
      (step: { name?: string }) => step.name === 'Validate Conventional Commit title',
    );
    const reuse = steps.findIndex((step: { id?: string }) => step.id === 'duplicate');
    expect(title).toBeGreaterThanOrEqual(0);
    expect(reuse).toBeGreaterThan(title);
    expect(workflow.on.pull_request.types).toContain('edited');
    expect(workflow.concurrency.group).toContain(
      "github.event_name == 'pull_request' && github.run_id",
    );
    expect(workflow.jobs.changes['timeout-minutes']).toBe(65);
    const detect = steps.find((step: { id?: string }) => step.id === 'detect');
    expect(detect?.env?.REUSE_PR_CHECKS).toContain('steps.duplicate.outputs.reuse');
    expect(detect?.run).toContain('if [ "${REUSE_PR_CHECKS:-false}" = "true" ]; then');
  });
});
