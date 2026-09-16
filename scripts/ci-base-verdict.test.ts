import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseRunEndpoint, waitForBaseVerdict } from './ci-base-verdict.mjs';

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

  // Execute the shipped routing condition: a helper-only test would stay green
  // if main pushes accidentally started waiting behind their predecessors.
  it.each([
    ['pull_request', 'true', 'in_progress/none', 'completed/success'],
    ['workflow_dispatch', 'true', 'queued/none', 'completed/success'],
    ['push', 'true', 'in_progress/none', 'in_progress/none'],
    ['pull_request', 'false', 'in_progress/none', 'in_progress/none'],
    ['pull_request', 'true', 'missing/none', 'missing/none'],
  ])('routes %s release_only=%s verdict=%s', (event, releaseOnly, initial, expected) => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const start = workflow.indexOf('              # Release Please opens its metadata PR');
    const end = workflow.indexOf(
      '              if [ "$verdict" = "completed/success" ]; then',
      start,
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const condition = workflow.slice(start, end).replaceAll('${{ github.event_name }}', event);
    const result = execFileSync(
      'bash',
      ['-c', `node() { echo completed/success; }\n${condition}\nprintf '%s' "$verdict"`],
      { encoding: 'utf8', env: { ...process.env, release_only: releaseOnly, verdict: initial } },
    );
    expect(result).toBe(expected);
  });
});
