import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Execute inside the tested image: host store code must not mask an old-image failure. */
export function upgradeDataProbeSource(phase: 'seed' | 'verify'): string {
  return `
import assert from 'node:assert/strict';
import { createPostgresDb, EventStore, executedSchemaGeneration } from '/app/packages/store/dist/index.js';
import { SERVER_COMPAT } from '/app/packages/server/dist/self-update/compat.js';
const db = createPostgresDb(process.env.DATABASE_URL);
const store = new EventStore(db);
const session = { sessionId: 'upgrade-data-proof', worktree: '/tmp/upgrade-data-proof', model: 'release-smoke' };
const events = [{ t: 'text', delta: 'Preserve this completed response across the upgrade.' }];
try {
  assert.equal(await executedSchemaGeneration(db), SERVER_COMPAT.schema.current, 'running image must have completed its migrations');
  if (${JSON.stringify(phase)} === 'seed') {
    await store.createSession(session);
    for (const event of events) await store.appendEvent(session.sessionId, event);
    await store.setSessionSlideDeck({ sessionId: session.sessionId, fileId: 'upgrade-slide', name: 'Upgrade proof', webViewLink: 'https://example.test/upgrade-slide' });
  }
  const actual = await store.getSession(session.sessionId);
  assert.ok(actual, 'pre-upgrade session must survive');
  assert.equal(actual.worktree, session.worktree);
  assert.equal(actual.model, session.model);
  assert.deepEqual(await store.getEvents(session.sessionId), events, 'pre-upgrade events must survive exactly once and unchanged');
  const slide = await store.getSessionSlideDeck(session.sessionId);
  assert.ok(slide, 'pre-upgrade slide assignment must survive');
  assert.equal(slide.fileId, 'upgrade-slide');
  assert.equal(slide.name, 'Upgrade proof');
  assert.equal(slide.webViewLink, 'https://example.test/upgrade-slide');
} finally {
  await store.waitForMessageProjectionIdle();
  await db.destroy();
}
`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2];
  if (phase !== 'seed' && phase !== 'verify') throw new Error('Expected seed or verify');
  process.stdout.write(upgradeDataProbeSource(phase));
}
