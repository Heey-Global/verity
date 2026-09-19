import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventStore, executedSchemaGeneration, migrateToLatest } from '@verity/store';
import { createRawDb } from '@verity/store/testing';
import { expect, it } from 'vitest';
import { SERVER_COMPAT } from './self-update/compat.js';
import { upgradeDataProbeSource } from './self-update-data-probe.js';

it('runs the image data probe and detects loss after a successful migration', async () => {
  const { db, close } = createRawDb();
  const store = new EventStore(db);
  const run = async (phase: 'seed' | 'verify') => {
    const source = upgradeDataProbeSource(phase)
      .replace(/^import .*;$/gm, '')
      .replace('const db = createPostgresDb(process.env.DATABASE_URL);', '')
      .replace('const store = new EventStore(db);', '')
      .replace('await db.destroy();', '');
    await (runInNewContext(`(async () => {${source}})()`, {
      db,
      store,
      executedSchemaGeneration,
      SERVER_COMPAT,
      assert: {
        ...assert,
        // The VM fixture has distinct prototypes; the real image runs in one realm.
        deepEqual: (actual: unknown, expected: unknown, message: string) =>
          assert.deepEqual(
            JSON.parse(JSON.stringify(actual)),
            JSON.parse(JSON.stringify(expected)),
            message,
          ),
      },
    }) as Promise<void>);
  };
  try {
    await migrateToLatest(db);
    await run('seed');
    await run('verify');
    await store.clearSessionSlideDeck('upgrade-data-proof');
    await expect(run('verify')).rejects.toThrow('slide assignment must survive');
  } finally {
    await close();
  }
});

it('release smoke seeds predecessor data and verifies both commit and restart before success', () => {
  const smoke = readFileSync('deploy/bin/verity-self-update-live-smoke', 'utf8');
  const seed = smoke.indexOf('upgrade_data_probe seed');
  const prepare = smoke.indexOf('self-update-live-smoke.js prepare');
  const cutover = smoke.indexOf('self-update-live-smoke.js cutover\n', prepare);
  const firstVerify = smoke.indexOf('upgrade_data_probe verify', cutover);
  const restart = smoke.indexOf('self-update-live-smoke.js updater-restarts', cutover);
  const secondVerify = smoke.indexOf('upgrade_data_probe verify', restart);
  const success = smoke.indexOf('  exit 0', restart);
  expect(seed).toBeGreaterThan(0);
  expect(prepare).toBeGreaterThan(seed);
  expect(cutover).toBeGreaterThan(prepare);
  expect(firstVerify).toBeGreaterThan(cutover);
  expect(restart).toBeGreaterThan(firstVerify);
  expect(secondVerify).toBeGreaterThan(restart);
  expect(success).toBeGreaterThan(secondVerify);
  expect(smoke).toContain('docker exec -i "$server" node --input-type=module');
  const workflow = readFileSync('.github/workflows/self-update.yml', 'utf8');
  expect(workflow).toContain('install -m 0644 packages/server/src/self-update-data-probe.ts');
  expect(workflow).toContain(
    'install -m 0644 "$RUNNER_TEMP/verity-self-update-harness/self-update-data-probe.ts"',
  );
});

it('publication probes the real candidate version rather than a synthetic future release', () => {
  const workflow = readFileSync('.github/workflows/self-update.yml', 'utf8');
  expect(workflow).toContain('smoke_version="$under_test"');
  expect(workflow).toContain("VERITY_SMOKE_CANDIDATE_SHA: ${{ inputs.candidate-sha || '' }}");
  expect(workflow).toContain('if [[ -z "${VERITY_SMOKE_CANDIDATE_SHA:-}" ]]; then');
  expect(workflow).toContain("printf 'VERITY_SMOKE_SERVER_VERSION=%s\\n' ");
});
