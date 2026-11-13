import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { resolve } from 'node:path';

const MiB = 1024 * 1024;
/** Sandboxes share one container limit with other sessions; keep their workers small. */
export const LOCAL_HEAP_CAP_MIB = 512;
/** A CI job owns its runner. The server's type graph alone needs about 330 MiB, and
 * linting server.ts peaks near 510 MiB, so the local cap fails CI by a few MiB. */
export const CI_HEAP_CAP_MIB = 2048;
const batchSize = 16;
// Large suites need their own worker even when a group contains few files.
const batchSourceBytes = 128 * 1024;

/**
 * Reserve room for native allocations, the supervisor and other processes.
 * An unavailable ceiling uses a small fixed budget; it never grows after an OOM.
 * @param {number} ceiling
 * @param {number} [current]
 * @param {number} [cap]
 */
export function heapLimitMiB(ceiling, current = 0, cap = LOCAL_HEAP_CAP_MIB) {
  if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling >= 1024 ** 5)
    return Math.min(LOCAL_HEAP_CAP_MIB, cap);
  const room = current > 0 ? Math.max(0, ceiling - current) : ceiling / 2;
  const budget = Math.floor(Math.min(cap, ceiling / (4 * MiB), room / (2 * MiB) - 64));
  if (budget < 64) throw new Error('Insufficient available memory to start a lint worker safely.');
  return budget;
}

/** @param {string} path */
function readLimit(path) {
  try {
    return Number(readFileSync(path, 'utf8').trim());
  } catch {
    return 0;
  }
}

/**
 * @param {{ ci?: boolean, limits?: number[], current?: number, total?: number, free?: number }} [probe]
 */
export function workerHeapLimit(probe = {}) {
  // Tools commonly export CI=1 to suppress prompts, sandboxes included; only a
  // GitHub Actions job is known to own its runner.
  const ci = probe.ci ?? process.env.GITHUB_ACTIONS === 'true';
  const ceilings = (
    probe.limits ?? [
      process.constrainedMemory(),
      readLimit('/sys/fs/cgroup/memory.max'),
      readLimit('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    ]
  ).filter((value) => Number.isFinite(value) && value > 0 && value < 1024 ** 5);
  // Hosted CI runners expose no cgroup limit. Without the machine's memory as the
  // ceiling they would fall back to the local budget and fail on the server graph.
  // Sandboxes keep that fallback: their machine memory is shared with other sessions.
  const machine = !ceilings.length && ci;
  const total = probe.total ?? totalmem();
  const ceiling = ceilings.length ? Math.min(...ceilings) : machine ? total : 0;
  const usage =
    probe.current ??
    (readLimit('/sys/fs/cgroup/memory.current') ||
      readLimit('/sys/fs/cgroup/memory/memory.usage_in_bytes') ||
      0);
  // A machine-sized ceiling must also count what runs outside this cgroup.
  const current = machine ? Math.max(usage, total - (probe.free ?? freemem())) : usage;
  return heapLimitMiB(ceiling, current, ci ? CI_HEAP_CAP_MIB : LOCAL_HEAP_CAP_MIB);
}

/**
 * @typedef {{ status: number | null, signal?: NodeJS.Signals | null,
 * stdout?: string, stderr?: string, error?: Error }} WorkerResult
 */

/**
 * @param {string[]} files
 * @param {number} heapMiB
 * @param {boolean} cache
 * @param {boolean} ambientCache
 * @returns {WorkerResult}
 */
function executeLint(files, heapMiB, cache, ambientCache) {
  // Disable core dumps before Node starts: an expected heap abort must not write
  // a potentially large dump. File names are positional arguments, never shell code.
  return spawnSync(
    'bash',
    [
      resolve(import.meta.dirname, 'lint-worker.sh'),
      process.execPath,
      `--max-old-space-size=${heapMiB}`,
      '--expose-gc',
      resolve(import.meta.dirname, 'lint-files.mjs'),
      ...(cache ? ['--local-cache'] : []),
      ...(!ambientCache ? ['--no-ambient-cache'] : []),
      '--',
      ...files,
    ],
    { encoding: 'utf8', maxBuffer: 16 * MiB },
  );
}

/**
 * @param {string[]} files
 * @param {{ cache?: boolean, ambientCache?: boolean, heapMiB?: number, execute?: (files: string[], heapMiB: number, ambientCache: boolean) => WorkerResult,
 * output?: (text: string) => void, error?: (text: string) => void }} [options]
 */
export function runLint(files, options = {}) {
  if (!files.length) throw new Error('Provide explicit file paths to lint.');
  const heapMiB = options.heapMiB ?? workerHeapLimit();
  const execute =
    options.execute ??
    ((batch, heap, ambientCache) =>
      executeLint(batch, heap, ambientCache && (options.cache ?? false), ambientCache));
  const output = options.output ?? ((text) => process.stdout.write(text));
  const error = options.error ?? ((text) => process.stderr.write(text));
  /** @param {string[]} batch @param {boolean} [ambientCache] @returns {number} */
  function check(batch, ambientCache = options.ambientCache ?? true) {
    const result = execute(batch, heapMiB, ambientCache);
    if (result.status === 0 && !result.error) {
      output(result.stdout ?? '');
      error(result.stderr ?? '');
      return 0;
    }
    const memoryFailure =
      !result.error &&
      (result.signal === 'SIGKILL' ||
        /FATAL ERROR:.*(?:heap out of memory|Allocation failed)/i.test(result.stderr ?? ''));
    if (memoryFailure) {
      if (batch.length === 1) {
        if (ambientCache) {
          // Optional classification metadata must not crowd out the actual type graph.
          // Retry once in a fresh worker; rules, roots and heap budget stay unchanged.
          error(
            `Lint worker reached its memory budget; retrying ${batch[0]} without optional lint caches.\n`,
          );
          return check(batch, false);
        }
        error(`Lint could not check ${batch[0]} within the ${heapMiB} MiB heap budget.\n`);
        error('No successful lint result was accepted for this file.\n');
        return 1;
      }
      error(
        `Lint worker reached its memory budget; retrying ${batch.length} files in smaller groups.\n`,
      );
      const middle = Math.ceil(batch.length / 2);
      return check(batch.slice(0, middle)) || check(batch.slice(middle));
    }
    output(result.stdout ?? '');
    error(result.stderr ?? '');
    if (result.error) error(`${result.error.message}\n`);
    else if (result.signal) error(`Lint worker terminated with ${result.signal}.\n`);
    return result.status || 1;
  }
  let batch = [];
  let bytes = 0;
  for (const file of files) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // ESLint reports missing or unreadable inputs; never omit them here.
    }
    if (batch.length && (batch.length >= batchSize || bytes + size > batchSourceBytes)) {
      const status = check(batch);
      if (status !== 0) return status;
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) {
    const status = check(batch);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const args = process.argv.slice(2);
    const cache = !process.env.CI && !args.includes('--no-cache');
    process.exitCode = runLint(
      args.filter((argument) => argument !== '--' && argument !== '--no-cache'),
      { cache, ambientCache: !args.includes('--no-cache') },
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
