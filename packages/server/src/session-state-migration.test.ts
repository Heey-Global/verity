import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  migrateOpenCodeSession,
  purgeOpenCodeSessions,
} from '../../../features/verity-sandbox-toolkit/bin/verity-session-state.mjs';

it('migrates native child sessions, pending work and events without foreign conversations or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-opencode-migration-'));
  const sourcePath = join(root, 'legacy.db');
  const targetPath = join(root, 'session', 'opencode.db');
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec(`CREATE TABLE project (id TEXT PRIMARY KEY);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, project_id TEXT REFERENCES project(id), metadata TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session_v2(id), data TEXT);
      CREATE TABLE session_pending (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session_v2(id), data TEXT);
      CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER);
      CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT REFERENCES event_sequence(aggregate_id), data TEXT);
      CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE migration (id INTEGER PRIMARY KEY);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO project VALUES ('project'); INSERT INTO migration VALUES (1);
      INSERT INTO session_v2 VALUES ('own', NULL, 'project', 'native metadata'), ('child', 'own', 'project', 'child state'), ('foreign', NULL, 'project', 'foreign metadata');
      INSERT INTO session_message VALUES ('own-message', 'own', 'completed tool result'), ('child-message', 'child', 'subagent result'), ('foreign-message', 'foreign', 'foreign conversation');
      INSERT INTO session_pending VALUES ('pending', 'own', 'pending work');
      INSERT INTO event_sequence VALUES ('own', 1), ('foreign', 1);
      INSERT INTO event VALUES ('own-event', 'own', 'session event'), ('foreign-event', 'foreign', 'foreign event');
      INSERT INTO credential VALUES ('account', 'synthetic credential');`);
    source.close();
    expect(await migrateOpenCodeSession(sourcePath, targetPath, 'own')).toMatchObject({
      migrated: true,
      sessionIds: ['own', 'child'],
    });
    const target = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(target.prepare('SELECT id FROM session_v2 ORDER BY id').all()).toEqual([
        { id: 'child' },
        { id: 'own' },
      ]);
      expect(target.prepare('SELECT data FROM session_pending').get()).toEqual({
        data: 'pending work',
      });
      expect(target.prepare('SELECT data FROM event').all()).toEqual([{ data: 'session event' }]);
      expect(target.prepare('SELECT count(*) AS count FROM credential').get()).toEqual({
        count: 0,
      });
      expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      target.close();
    }
    expect(await migrateOpenCodeSession(sourcePath, targetPath, 'own')).toMatchObject({
      migrated: false,
    });
    const original = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      expect(original.prepare('SELECT count(*) AS count FROM session_v2').get()).toEqual({
        count: 3,
      });
    } finally {
      original.close();
    }
  } finally {
    if (source.isOpen) source.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('purges the owned session tree with restrictive foreign keys and retains unrelated rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verity-opencode-purge-'));
  const path = join(root, 'legacy.db');
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES session_v2(id));
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT REFERENCES session_v2(id));
      CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY);
      CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT REFERENCES event_sequence(aggregate_id));
      INSERT INTO session_v2 VALUES ('own', NULL), ('child', 'own'), ('foreign', NULL);
      INSERT INTO session_message VALUES ('child-message', 'child'), ('foreign-message', 'foreign');
      INSERT INTO event_sequence VALUES ('own'), ('foreign');
      INSERT INTO event VALUES ('own-event', 'own'), ('foreign-event', 'foreign');`);
    await purgeOpenCodeSessions(path, ['own']);
    expect(db.prepare('SELECT id FROM session_v2').all()).toEqual([{ id: 'foreign' }]);
    expect(db.prepare('SELECT id FROM session_message').all()).toEqual([{ id: 'foreign-message' }]);
    expect(db.prepare('SELECT id FROM event').all()).toEqual([{ id: 'foreign-event' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    await purgeOpenCodeSessions(path, ['own']);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
