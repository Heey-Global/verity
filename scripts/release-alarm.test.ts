import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { crashThreshold, planAlarm } from './release-alarm.mjs';

const runUrl = 'https://github.com/o/r/actions/runs/7';
const base = { recentConclusions: [], issue: undefined, runUrl, mention: 'owner' };
const draft = 'backend: v1.2.3 exists as a draft';
const failed = 'OTA: promotion run ended with failure';

function issueFor(problems: string[]) {
  const plan = planAlarm({ ...base, result: 'failure', problems });
  if (plan.action !== 'open') throw new Error('expected an open plan');
  return { number: 12, body: plan.body };
}

describe('release stall alarm', () => {
  it('opens one issue that mentions the owner and lists every problem', () => {
    const plan = planAlarm({ ...base, result: 'failure', problems: [draft, failed] });
    expect(plan.action).toBe('open');
    if (plan.action !== 'open') return;
    expect(plan.body).toContain('@owner');
    expect(plan.body).toContain(`- ${draft}`);
    expect(plan.body).toContain(`- ${failed}`);
    expect(plan.body).toContain(runUrl);
  });

  it('stays quiet while the same problems persist', () => {
    const issue = issueFor([draft]);
    expect(planAlarm({ ...base, result: 'failure', problems: [draft], issue })).toEqual({
      action: 'none',
    });
  });

  it('mentions the owner again only for a new problem', () => {
    const issue = issueFor([draft]);
    const plan = planAlarm({ ...base, result: 'failure', problems: [draft, failed], issue });
    expect(plan.action).toBe('update');
    if (plan.action !== 'update') return;
    expect(plan.comment).toContain('@owner');
    expect(plan.comment).toContain(failed);
    expect(plan.comment).not.toContain(draft);
  });

  it('updates silently when a problem is resolved but others remain', () => {
    const issue = issueFor([draft, failed]);
    const plan = planAlarm({ ...base, result: 'failure', problems: [draft], issue });
    expect(plan).toMatchObject({ action: 'update', number: 12, comment: '' });
  });

  it('closes the issue after a clean sweep', () => {
    const issue = issueFor([draft]);
    expect(planAlarm({ ...base, result: 'success', problems: [], issue })).toMatchObject({
      action: 'close',
      number: 12,
    });
    expect(planAlarm({ ...base, result: 'success', problems: [] })).toEqual({ action: 'none' });
  });

  it('ignores cancelled and skipped sweeps', () => {
    const issue = issueFor([draft]);
    for (const result of ['cancelled', 'skipped'])
      expect(planAlarm({ ...base, result, problems: undefined, issue })).toEqual({
        action: 'none',
      });
  });

  it('tolerates isolated crashes and never closes on one', () => {
    const issue = issueFor([draft]);
    expect(
      planAlarm({ ...base, result: 'failure', problems: undefined, issue, recentConclusions: [] }),
    ).toEqual({ action: 'none' });
    expect(
      planAlarm({
        ...base,
        result: 'failure',
        problems: undefined,
        recentConclusions: ['failure', 'success'],
      }),
    ).toEqual({ action: 'none' });
  });

  it('raises the alarm when the sweep keeps crashing', () => {
    const plan = planAlarm({
      ...base,
      result: 'failure',
      problems: undefined,
      recentConclusions: Array(crashThreshold - 1).fill('failure'),
    });
    expect(plan.action).toBe('open');
    if (plan.action === 'open') expect(plan.body).toContain('nothing is watching releases');
  });

  it('runs every five minutes and keeps issue writes out of the sweep job', () => {
    const workflow = parse(readFileSync('.github/workflows/release-reconcile.yml', 'utf8')) as {
      on: { schedule: { cron: string }[] };
      jobs: Record<
        string,
        {
          needs?: string;
          if?: string;
          outputs?: Record<string, string>;
          permissions?: Record<string, string>;
          steps?: { id?: string; run?: string; env?: Record<string, string> }[];
        }
      >;
    };
    expect(workflow.on.schedule).toEqual([{ cron: '2,7,12,17,22,27,32,37,42,47,52,57 * * * *' }]);
    const { reconcile, alarm } = workflow.jobs;
    expect(reconcile?.permissions?.issues).toBeUndefined();
    expect(reconcile?.outputs?.problems).toBe('${{ steps.sweep.outputs.problems }}');
    // Problems are a verdict, not a crash: only a sweep that never wrote its
    // verdict fails the job, which is what the crash count reads.
    expect(reconcile?.steps?.find((step) => step.id === 'sweep')?.run).toBe(
      `node scripts/release-reconcile.mjs || grep -q '^problems=' "$GITHUB_OUTPUT"`,
    );
    expect(alarm?.needs).toBe('reconcile');
    expect(alarm?.if).toBe('always()');
    expect(alarm?.permissions).toEqual({ actions: 'read', contents: 'read', issues: 'write' });
    const step = alarm?.steps?.find((entry) => entry.run === 'node scripts/release-alarm.mjs');
    expect(step?.env?.RECONCILE_RESULT).toBe('${{ needs.reconcile.result }}');
    expect(step?.env?.PROBLEMS).toBe('${{ needs.reconcile.outputs.problems }}');
  });
});
