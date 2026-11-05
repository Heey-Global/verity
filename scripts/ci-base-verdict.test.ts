import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseRunEndpoint, readBaseVerdict, waitForBaseVerdict } from './ci-base-verdict.mjs';

describe('release metadata base CI inheritance', () => {
  it('inherits only the exact main commit after its active check succeeds', async () => {
    const sha = 'a'.repeat(40);
    const endpoint = new URL(baseRunEndpoint('owner/repo', sha), 'https://api.github.com/');
    expect(endpoint.pathname).toBe('/repos/owner/repo/actions/workflows/ci.yml/runs');
    expect(endpoint.searchParams.get('head_sha')).toBe(sha);
    expect(endpoint.searchParams.get('event')).toBe('push');
    let clock = 0;
    let queries = 0;
    const verdict = await waitForBaseVerdict({
      initial: 'queued/none',
      query: async () => (++queries === 1 ? 'in_progress/none' : 'completed/success'),
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    });
    expect(verdict).toBe('completed/success');
    expect(queries).toBe(2);
    expect(clock).toBeGreaterThan(0);
  });

  it.each(['completed/failure', 'completed/cancelled', 'missing/none', 'unreadable/none'])(
    'does not wait or manufacture success from %s',
    async (initial) => {
      const verdict = await waitForBaseVerdict({
        initial,
        query: () => {
          throw new Error('A terminal or missing base must not be queried again');
        },
      });
      expect(verdict).toBe(initial);
    },
  );

  it('bounds waiting and fails broad when the base never settles', async () => {
    let clock = 0;
    let queries = 0;
    const verdict = await waitForBaseVerdict({
      initial: 'in_progress/none',
      timeoutMs: 45,
      intervalMs: 20,
      query: async (remaining) => {
        expect(remaining).toBeGreaterThan(0);
        queries += 1;
        return 'in_progress/none';
      },
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    });
    expect(verdict).toBe('timeout/none');
    expect(clock).toBe(45);
    expect(queries).toBe(2);
  });

  it('fails broad if a later API request fails', async () => {
    expect(
      await waitForBaseVerdict({
        initial: 'in_progress/none',
        pause: async () => undefined,
        query: () => {
          throw new Error('API unavailable');
        },
      }),
    ).toBe('unreadable/none');
  });

  it.each(['completed/failure', 'completed/cancelled', 'missing/none'])(
    'retains the full-check fallback when the active base becomes %s',
    async (next) => {
      expect(
        await waitForBaseVerdict({
          initial: 'in_progress/none',
          pause: async () => undefined,
          query: async () => next,
        }),
      ).toBe(next);
    },
  );

  it.each(['pull_request', 'workflow_dispatch', 'push'])(
    'only waits for metadata PRs (%s)',
    (event) => {
      const workflow = readFileSync(
        new URL('../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      );
      const start = workflow.indexOf('              # Release Please opens its metadata PR');
      const end = workflow.indexOf(
        '              if [ "$verdict" = "completed/success" ]; then',
        start,
      );
      const condition = workflow.slice(start, end).replaceAll('${{ github.event_name }}', event);
      for (const releaseOnly of ['true', 'false']) {
        const result = execFileSync(
          'bash',
          ['-c', `node() { printf '%s' "$*"; }\n${condition}\nprintf '%s' "$verdict"`],
          {
            encoding: 'utf8',
            env: { ...process.env, release_only: releaseOnly, verdict_base: 'a'.repeat(40) },
          },
        );
        expect(result.includes('--wait')).toBe(event !== 'push' && releaseOnly === 'true');
      }
    },
  );

  it('accepts a base which finishes after the previous 20-minute cutoff', async () => {
    let clock = 0;
    expect(
      await waitForBaseVerdict({
        initial: 'in_progress/none',
        query: async () => (clock > 25 * 60_000 ? 'completed/success' : 'in_progress/none'),
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
      }),
    ).toBe('completed/success');
    expect(clock).toBeGreaterThan(20 * 60_000);
    expect(clock).toBeLessThan(60 * 60_000);
  });

  const run = {
    id: 12,
    run_attempt: 1,
    repository: { full_name: 'owner/repo' },
    head_sha: 'a'.repeat(40),
    path: '.github/workflows/ci.yml',
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
  };
  it('logs the selected run and confirms success twice', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    expect(
      await readBaseVerdict(
        'owner/repo',
        run.head_sha,
        async (endpoint) => {
          calls.push(endpoint);
          return { workflow_runs: [run] };
        },
        (message) => logs.push(message),
      ),
    ).toBe('completed/success');
    expect(calls).toHaveLength(2);
    expect(logs[0]).toContain('run 12, attempt 1');
  });
  it.each([
    { head_sha: 'b'.repeat(40) },
    { repository: { full_name: 'other/repo' } },
    { path: '.github/workflows/other.yml' },
    { event: 'pull_request' },
    { head_branch: 'other' },
  ])('rejects mismatched base identity %j', async (override) => {
    await expect(
      readBaseVerdict('owner/repo', run.head_sha, async () => ({
        workflow_runs: [{ ...run, ...override }],
      })),
    ).rejects.toThrow('identity mismatch');
  });
  it('does not inherit a successful attempt superseded by a rerun', async () => {
    let reads = 0;
    expect(
      await readBaseVerdict('owner/repo', run.head_sha, async () => ({
        workflow_runs: [{ ...run, run_attempt: ++reads }],
      })),
    ).toBe('unreadable/none');
  });
});
