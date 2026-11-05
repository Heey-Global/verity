import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { waitForBaseVerdict } from './ci-base-verdict.mjs';

/** @typedef {{version: number, repository: string, head: string, base: string, tree: string}} Context */
/** @typedef {import('./ci-base-verdict.mjs').CiRun} CiRun */
/** @typedef {Partial<CiRun> & { workflow_runs?: CiRun[], jobs?: { name: string, conclusion: string }[] }} ApiResponse */
const execute = promisify(execFile);

/** Exact checkout tree includes source, workflow, configuration and dependencies.
 * @param {Context | undefined} a @param {Context | undefined} b
 */
export function sameContext(a, b) {
  return (
    a?.version === 1 &&
    b?.version === 1 &&
    /** @type {const} */ (['repository', 'head', 'base', 'tree']).every(
      (key) => typeof a[key] === 'string' && a[key].length > 0 && a[key] === b[key],
    )
  );
}

/** Only an older full CI run may own evidence; diagnostic runs cannot satisfy it.
 * @param {CiRun} run @param {Context} context @param {number} currentId
 */
export function eligibleRun(run, context, currentId) {
  return (
    Number.isSafeInteger(run?.id) &&
    run.id > 0 &&
    run.id < currentId &&
    Number.isSafeInteger(run.run_attempt) &&
    run.run_attempt > 0 &&
    run.repository?.full_name === context.repository &&
    run.head_sha === context.head &&
    run.path === '.github/workflows/ci.yml' &&
    run.event === 'pull_request'
  );
}

/**
 * Context artifacts are produced before routing. Older IDs prevent cycles when
 * two edits start together. No artifact, API failure or ambiguous proof => full CI.
 * @param {{ context: Context, currentId: number, api: (path: string) => Promise<ApiResponse>,
 * artifact: (id: number, attempt: number) => Promise<Context>,
 * wait?: typeof waitForBaseVerdict, pause?: (ms: number) => Promise<unknown>, log?: (message: string) => void }} options
 */
export async function reusePrEvidence({
  context,
  currentId,
  api,
  artifact,
  wait = waitForBaseVerdict,
  log = () => {},
  pause = delay,
}) {
  const prefix = `repos/${context.repository}/actions/runs`;
  const response = await api(`${prefix}?head_sha=${context.head}&per_page=30`);
  const candidates = (response.workflow_runs ?? [])
    .filter((run) => eligibleRun(run, context, currentId))
    .sort((a, b) => a.id - b.id);
  for (const candidate of candidates.slice(0, 5)) {
    let proof;
    // A simultaneous opened/edited event can reach this point before the
    // older run has uploaded its context. Briefly allow that upload to land.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        proof = await artifact(candidate.id, candidate.run_attempt);
        break;
      } catch {
        if (candidate.status === 'completed' || attempt === 3) break;
        await pause(10_000);
      }
    }
    if (!sameContext(context, proof)) continue;
    const endpoint = `${prefix}/${candidate.id}`;
    const query = async () => {
      const run = await api(endpoint);
      if (
        !eligibleRun(/** @type {CiRun} */ (run), context, currentId) ||
        run.id !== candidate.id ||
        run.run_attempt !== candidate.run_attempt
      ) {
        return 'unreadable/none';
      }
      log(
        `Matching PR CI run ${run.id}, attempt ${run.run_attempt}: ${run.status}/${run.conclusion ?? 'none'}`,
      );
      return `${run.status}/${run.conclusion ?? 'none'}`;
    };
    const initial = await query();
    const verdict = await wait({ initial, query });
    if (verdict !== 'completed/success') return false;
    // Re-read after waiting so a rerun cannot leave an old success authoritative.
    if ((await query()) !== 'completed/success') return false;
    const jobs = await api(`${endpoint}/attempts/${candidate.run_attempt}/jobs?per_page=100`);
    const gates = (jobs.jobs ?? []).filter((job) => job.name === 'ci-checks');
    if (gates.length !== 1 || gates[0].conclusion !== 'success') return false;
    return (await query()) === 'completed/success';
  }
  return false;
}

async function main() {
  const file = process.argv[3];
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
  const head = process.env.PR_HEAD_SHA ?? '';
  const base = process.env.PR_BASE_SHA ?? '';
  if (![head, base].every((sha) => /^[a-f0-9]{40}$/.test(sha)))
    throw new Error('Invalid PR context');
  const { stdout } = await execute('git', ['rev-parse', 'HEAD^{tree}']);
  const context = { version: 1, repository, head, base, tree: stdout.trim() };
  if (process.argv[2] === 'write') {
    await writeFile(file, JSON.stringify(context));
    if (process.env.GITHUB_ENV)
      await appendFile(
        process.env.GITHUB_ENV,
        `CI_EVIDENCE_DEADLINE=${Date.now() + 60 * 60 * 1000}\n`,
      );
    return;
  }
  const deadline = Number(process.env.CI_EVIDENCE_DEADLINE || Date.now() + 60 * 60 * 1000);
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error('Evidence deadline reached');
    return Math.min(30_000, budget);
  };
  const directory = await mkdtemp(join(tmpdir(), 'ci-pr-evidence-'));
  try {
    const result = await reusePrEvidence({
      context,
      currentId: Number(process.env.GITHUB_RUN_ID),
      api: async (endpoint) => {
        const { stdout: body } = await execute('gh', ['api', endpoint], {
          timeout: remaining(),
          maxBuffer: 1024 * 1024,
        });
        const parsed = /** @type {unknown} */ (JSON.parse(body));
        return /** @type {ApiResponse} */ (parsed);
      },
      artifact: async (id, attempt) => {
        const target = join(directory, `${id}-${attempt}`);
        await execute(
          'gh',
          [
            'run',
            'download',
            String(id),
            '--repo',
            repository,
            '--name',
            `ci-context-${attempt}`,
            '--dir',
            target,
          ],
          { timeout: remaining(), maxBuffer: 64 * 1024 },
        );
        const parsed = /** @type {unknown} */ (
          JSON.parse(await readFile(join(target, 'ci-context.json'), 'utf8'))
        );
        return /** @type {Context} */ (parsed);
      },
      wait: (options) =>
        waitForBaseVerdict({
          ...options,
          timeoutMs: Math.max(
            0,
            Number(process.env.CI_EVIDENCE_DEADLINE || Date.now() + 60 * 60 * 1000) - Date.now(),
          ),
        }),
      log: (message) => process.stderr.write(`${message}\n`),
    });
    process.stdout.write(result ? 'true\n' : 'false\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (process.argv[2] === 'write') throw error;
    process.stderr.write('PR CI evidence unavailable; running normal checks.\n');
    process.stdout.write('false\n');
  });
}
