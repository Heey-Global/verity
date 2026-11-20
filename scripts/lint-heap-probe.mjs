import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runLint } from './lint-runner.mjs';

/** Measure the failing root with the runner's unchanged resource budget.
 * @param {string} directory
 */
export function measureLintHeap(directory) {
  mkdirSync(directory, { recursive: true });
  return runLint(['packages/server/src/server.ts'], {
    cache: false,
    ambientCache: false,
    execute(files, heapMiB, ambientCache) {
      const stdoutPath = join(directory, 'worker-gc.log');
      const stderrPath = join(directory, 'worker-stderr.log');
      const metadataPath = join(directory, 'worker.json');
      const metadata = { files, heapMiB, ambientCache, versions: process.versions };
      writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      const stdout = openSync(stdoutPath, 'w');
      const stderr = openSync(stderrPath, 'w');
      try {
        // Native GC traces run even while synchronous type analysis blocks JS.
        // Write directly to disk: the normal runner discards partial OOM output.
        const result = spawnSync(
          'bash',
          [
            resolve(import.meta.dirname, 'lint-worker.sh'),
            process.execPath,
            `--max-old-space-size=${heapMiB}`,
            '--expose-gc',
            '--trace-gc-nvp',
            resolve(import.meta.dirname, 'lint-files.mjs'),
            '--no-ambient-cache',
            '--',
            ...files,
          ],
          { stdio: ['ignore', stdout, stderr] },
        );
        writeFileSync(
          metadataPath,
          JSON.stringify(
            {
              ...metadata,
              status: result.status,
              signal: result.signal,
              error: result.error?.message,
            },
            null,
            2,
          ),
        );
        return {
          ...result,
          stdout: '',
          // Preserve the runner's OOM classification and nonzero exit status.
          stderr: readFileSync(stderrPath, 'utf8'),
        };
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
    },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Provide an output directory for lint heap measurements.');
  process.exitCode = measureLintHeap(resolve(directory));
}
