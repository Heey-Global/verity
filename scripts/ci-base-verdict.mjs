import { execFile } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const active = new Set(['queued/none', 'in_progress/none', 'pending/none', 'waiting/none']);

/**
 * Only a running exact-base check can become inherited evidence. Failure or an
 * unavailable verdict must retain the workflow's full-check fallback.
 * @param {{ initial: string, query: (remainingMs: number) => Promise<string>,
 * timeoutMs?: number, intervalMs?: number, now?: () => number,
 * pause?: (ms: number) => Promise<unknown> }} options
 */
export async function waitForBaseVerdict({
  initial,
  query,
  timeoutMs = 20 * 60 * 1000,
  intervalMs = 20 * 1000,
  now = Date.now,
  pause = delay,
}) {
  const deadline = now() + timeoutMs;
  let verdict = initial;
  while (active.has(verdict)) {
    const remaining = deadline - now();
    if (remaining <= 0) return 'timeout/none';
    await pause(Math.min(intervalMs, remaining));
    if (now() >= deadline) return 'timeout/none';
    try {
      verdict = await query(deadline - now());
    } catch {
      return 'unreadable/none';
    }
    if (now() >= deadline) return 'timeout/none';
  }
  return verdict;
}

/** @param {string} repository @param {string} sha */
export function baseRunEndpoint(repository, sha) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error('An exact repository and base SHA are required');
  }
  return `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=1`;
}

async function main() {
  const endpoint = baseRunEndpoint(process.env.GITHUB_REPOSITORY ?? '', process.argv[2] ?? '');
  const initial = process.argv[3] ?? 'missing/none';
  process.stderr.write('Waiting up to 20 minutes for the exact release base CI verdict.\n');
  const verdict = await waitForBaseVerdict({
    initial,
    query: async (remainingMs) => {
      const { stdout } = await execute(
        'gh',
        [
          'api',
          endpoint,
          '--jq',
          '(.workflow_runs[0] // {}) | "\\(.status // "missing")/\\(.conclusion // "none")"',
        ],
        { timeout: Math.min(30_000, remainingMs), maxBuffer: 64 * 1024 },
      );
      return stdout.trim();
    },
  });
  process.stdout.write(`${verdict}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write('unreadable/none\n');
  });
}
