import { describe, expect, it } from 'vitest';
import { resumeSuperseded } from './release-superseded-handoff.mjs';

const head = 'a'.repeat(40);
const newer = 'b'.repeat(40);
function fixture() {
  const writes: string[][] = [];
  let reads = 0;
  let change = false;
  let runs: Record<string, unknown>[] = [];
  let claimed = false;
  let failure = false;
  const gh = (args: string[]) => {
    if (args.some((arg) => arg.includes('/git/ref/heads/main')))
      return change && reads++ > 0 ? newer : head;
    if (args.includes('POST')) {
      writes.push(args);
      if (claimed) throw new Error('claim conflict');
      claimed = true;
      return '{}';
    }
    if (args.some((arg) => arg.includes('matching-refs')))
      return JSON.stringify(
        claimed ? [{ ref: `refs/tags/release-reconcile-attempt/${head}` }] : [],
      );
    if (args.includes('--slurp')) return JSON.stringify([{ workflow_runs: runs }]);
    if (args[0] === 'workflow') {
      writes.push(args);
      if (failure) throw new Error('dispatch failed');
      return '';
    }
    throw new Error('unexpected command');
  };
  return {
    gh,
    writes,
    advance: () => {
      change = true;
    },
    fail: () => {
      failure = true;
    },
    runs: (value: Record<string, unknown>[]) => {
      runs = value;
    },
  };
}
describe('superseded snapshot handoff', () => {
  it('reserves and dispatches once even before the new run becomes visible', () => {
    const f = fixture();
    expect(resumeSuperseded('example/repo', [head, head], f.gh)).toContain('Requested');
    expect(f.writes[0]).toContain(`sha=${head}`);
    expect(f.writes[1]).toContain('reconcile=true');
    expect(() => resumeSuperseded('example/repo', [head], f.gh)).toThrow('already reserved');
    expect(f.writes).toHaveLength(2);
  });
  it.each(['in_progress', 'completed'])('deduplicates an existing %s reconcile', (status) => {
    const f = fixture();
    f.runs([
      {
        head_sha: head,
        display_title: 'Reconcile unpublished releases',
        status,
        conclusion: 'failure',
        html_url: 'https://example.test/run',
      },
    ]);
    if (status === 'completed')
      expect(() => resumeSuperseded('example/repo', [head], f.gh)).toThrow('already attempted');
    else expect(resumeSuperseded('example/repo', [head], f.gh)).toContain('already active');
    expect(f.writes).toHaveLength(0);
  });
  it('retains a failed dispatch claim instead of retrying indefinitely', () => {
    const f = fixture();
    f.fail();
    expect(() => resumeSuperseded('example/repo', [head], f.gh)).toThrow('dispatch failed');
    expect(() => resumeSuperseded('example/repo', [head], f.gh)).toThrow('already reserved');
    expect(f.writes).toHaveLength(2);
  });
  it('leaves a newer main to the scheduled backstop', () => {
    const f = fixture();
    f.advance();
    expect(resumeSuperseded('example/repo', [head], f.gh)).toContain('advanced before dispatch');
    expect(f.writes).toHaveLength(0);
    expect(resumeSuperseded('example/repo', [newer], fixture().gh)).toContain('Main advanced');
  });
  it('does not mistake a manual recovery or replan for reconciliation', () => {
    const f = fixture();
    f.runs([
      {
        head_sha: head,
        display_title: 'Replan native mobile',
        status: 'completed',
        html_url: 'https://example.test/manual',
      },
    ]);
    expect(resumeSuperseded('example/repo', [head], f.gh)).toContain('Requested');
  });
  it('does not dispatch if a competing caller wins the atomic reservation', () => {
    const f = fixture();
    expect(() =>
      resumeSuperseded('example/repo', [head], (args) => {
        if (args.includes('POST')) throw new Error('claim conflict');
        return f.gh(args);
      }),
    ).toThrow('claim conflict');
    expect(f.writes).toHaveLength(0);
  });
  it('rejects malformed metadata instead of assuming no prior attempts', () => {
    const f = fixture();
    expect(() =>
      resumeSuperseded('example/repo', [head], (args) =>
        args.includes('--slurp') ? '{}' : f.gh(args),
      ),
    ).toThrow('Invalid workflow run pages');
    expect(f.writes).toHaveLength(0);
  });
  it('propagates API errors without dispatching', () => {
    expect(() =>
      resumeSuperseded('example/repo', [head], () => {
        throw new Error('API unavailable');
      }),
    ).toThrow('API unavailable');
  });
});
