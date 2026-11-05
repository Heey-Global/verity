import { execFile } from 'node:child_process';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** @typedef {{ id: number, run_attempt: number, repository?: {full_name?: string},
 * head_sha?: string, path?: string, event?: string, head_branch?: string,
 * status?: string, conclusion?: string | null }} CiRun */
/** @typedef {{ workflow_runs?: CiRun[] }} RunList */
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
  timeoutMs = 60 * 60 * 1000,
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

/**
 * Re-read the latest attempt before accepting green evidence. A successful old
 * attempt must not hide a rerun which is currently queued or failing.
 * @param {string} repository
 * @param {string} sha
 * @param {(endpoint: string) => Promise<RunList>} api
 * @param {(message: string) => void} [log]
 */
export async function readBaseVerdict(repository, sha, api, log = () => {}) {
  const endpoint = baseRunEndpoint(repository, sha);
  const read = async () => {
    const response = await api(endpoint);
    const run = response.workflow_runs?.[0];
    if (!run) return null;
    if (
      run.repository?.full_name !== repository ||
      run.head_sha !== sha ||
      run.path !== '.github/workflows/ci.yml' ||
      run.event !== 'push' ||
      run.head_branch !== 'main' ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt <= 0
    )
      throw new Error('Base CI identity mismatch');
    log(
      `Base CI ${sha}: run ${run.id}, attempt ${run.run_attempt}, ${run.status}/${run.conclusion ?? 'none'}`,
    );
    return run;
  };
  const run = await read();
  if (!run) return 'missing/none';
  if (run.status === 'completed' && run.conclusion === 'success') {
    const confirmed = await read();
    if (!confirmed) return 'missing/none';
    if (confirmed.id !== run.id || confirmed.run_attempt !== run.run_attempt) {
      return 'unreadable/none';
    }
    return `${confirmed.status ?? 'missing'}/${confirmed.conclusion ?? 'none'}`;
  }
  return `${run.status ?? 'missing'}/${run.conclusion ?? 'none'}`;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.argv[2] ?? '';
  const wait = process.argv[3] === '--wait';
  const query = async (remainingMs = 60_000) =>
    readBaseVerdict(
      repository,
      sha,
      async (endpoint) => {
        const { stdout } = await execute('gh', ['api', endpoint], {
          timeout: Math.min(30_000, Math.max(1, Math.floor(remainingMs / 2))),
          maxBuffer: 128 * 1024,
        });
        const parsed = /** @type {unknown} */ (JSON.parse(stdout));
        return /** @type {RunList} */ (parsed);
      },
      (message) => process.stderr.write(`${message}\n`),
    );
  const initial = await query();
  if (wait && active.has(initial)) {
    process.stderr.write('Waiting up to 60 minutes for the exact release base CI verdict.\n');
  }
  const remaining = Number(process.env.CI_EVIDENCE_DEADLINE) - Date.now();
  const timeoutMs = Number.isFinite(remaining) ? Math.max(0, remaining) : 60 * 60 * 1000;
  const verdict = wait ? await waitForBaseVerdict({ initial, query, timeoutMs }) : initial;
  process.stdout.write(`${verdict}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write('unreadable/none\n');
  });
}
