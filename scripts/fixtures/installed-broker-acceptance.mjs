// Run only as root inside the disposable managed-install acceptance Runner.
// This seeds turn metadata to exercise the installed broker, not provider grants.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const installedSupervisorPath = '/usr/local/bin/verity-runner-supervisor';
/** @type {unknown} */
const installedSupervisor = await import(installedSupervisorPath);
assert.ok(
  installedSupervisor !== null &&
    typeof installedSupervisor === 'object' &&
    'runTrustedCliViaBroker' in installedSupervisor &&
    typeof installedSupervisor.runTrustedCliViaBroker === 'function',
  'installed supervisor is missing its broker helper',
);
const runTrustedCliViaBroker =
  /** @type {(request: unknown, options: { runtimeDir: string }) => Promise<{ exitCode: number, stdout: string, stderr: string }>} */ (
    installedSupervisor.runTrustedCliViaBroker
  );

assert.equal(
  process.env.VERITY_INSTALLED_BROKER_ACCEPTANCE,
  '1',
  'explicit disposable Runner opt-in is required',
);
assert.equal(process.getuid(), 0, 'acceptance observer must run as root');
const runtimeDir = '/run/verity-runner';
const secretRoot = join(runtimeDir, 'secrets');
const turnId = `acceptance-${randomUUID()}`;
const turnDir = join(runtimeDir, 'turns', turnId);
const cwd = await mkdtemp('/work/broker-acceptance-');
await chmod(cwd, 0o777);
await mkdir(turnDir, { recursive: true });
await writeFile(
  join(turnDir, 'request.json'),
  JSON.stringify({ turnId, cwd, trustedCliExecution: true }),
);
const release = join(cwd, 'release');
const ids = [randomUUID(), randomUUID()];
const pending = [];
const knownIds = [...ids];
/** @param {string} value */
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
/** @param {string} path */
const absent = async (path) => {
  await assert.rejects(lstat(path), { code: 'ENOENT' });
};
/** @param {string} correlationId @param {string} suffix
 * @returns {Parameters<typeof runTrustedCliViaBroker>[0] & {protocolVersion: number, kind: string, correlationId: string}}
 */
const request = (correlationId, suffix) => {
  const secret = `synthetic-${correlationId}-Grüße\nsecond line`;
  return {
    protocolVersion: 1,
    kind: 'run-trusted-cli',
    turnId,
    correlationId,
    secrets: [
      { secretAlias: 'VERITY_CANARY_SECRET', env: 'ACCEPTANCE_VALUE', injection: 'env', secret },
      { secretAlias: 'VERITY_CANARY_SECRET', env: 'ACCEPTANCE_FILE', injection: 'file', secret },
    ],
    command: [
      '/bin/sh',
      '-c',
      `set -eu; test "$(id -u)" != 0; test "$(stat -c %a "$ACCEPTANCE_FILE")" = 600; printf %s "$ACCEPTANCE_VALUE" | cmp -s - "$ACCEPTANCE_FILE"; ${suffix}`,
    ],
  };
};
/** @param {string} id @param {string} suffix */
const run = (id, suffix) => runTrustedCliViaBroker(request(id, suffix), { runtimeDir });
/** @param {Awaited<ReturnType<typeof run>>} result */
const assertSuccess = (result) => {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '[REDACTED]');
  assert.equal(result.stderr, '');
};
try {
  for (const id of ids) {
    pending.push(
      run(
        id,
        `touch ${quote(join(cwd, `${id}.ready`))}; attempts=0; while [ ! -f ${quote(release)} ]; do attempts=$((attempts + 1)); test "$attempts" -lt 6000; sleep 0.01; done; cat "$ACCEPTANCE_FILE"`,
      ),
    );
  }
  for (const promise of pending) promise.catch(() => undefined);
  // A serial broker cannot reach this barrier: both children have read their
  // own values and keep their files alive until the observer releases them.
  const deadline = Date.now() + 30_000;
  while (true) {
    const ready = await Promise.all(
      ids.map((id) =>
        lstat(join(cwd, `${id}.ready`)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (ready.every(Boolean)) break;
    assert.ok(Date.now() < deadline, 'concurrent children did not reach the barrier');
    await delay(20);
  }
  for (const id of ids) {
    assert.equal(
      await readFile(join(secretRoot, id, 'ACCEPTANCE_FILE'), 'utf8'),
      `synthetic-${id}-Grüße\nsecond line`,
    );
  }
  await writeFile(release, 'release');
  for (const result of await Promise.all(pending)) assertSuccess(result);
  for (const id of ids) await absent(join(secretRoot, id));
  const terminatedId = randomUUID();
  knownIds.push(terminatedId);
  const terminated = await run(terminatedId, 'cat "$ACCEPTANCE_FILE"; kill -TERM $$; exit 99');
  assert.equal(terminated.exitCode, 1);
  assert.equal(terminated.stdout, '[REDACTED]');
  assert.equal(terminated.stderr, '');
  await absent(join(secretRoot, terminatedId));
  const retryId = randomUUID();
  knownIds.push(retryId);
  assertSuccess(await run(retryId, 'cat "$ACCEPTANCE_FILE"'));
  await absent(join(secretRoot, retryId));
  console.log(
    'Installed broker acceptance passed: non-root read, Unicode env/file equality, overlapping calls, redaction, SIGTERM cleanup and retry.',
  );
} finally {
  await writeFile(release, 'release');
  await Promise.allSettled(pending);
  // Assertions above precede this fixture-owned cleanup; it cannot hide a leak.
  for (const id of knownIds) await rm(join(secretRoot, id), { recursive: true, force: true });
  await rm(turnDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
}
