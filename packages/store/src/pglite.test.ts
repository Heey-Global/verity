import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '@verity/events';
import { CompiledQuery } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';

import { migrateToLatest } from './db.js';
import { createEmbeddedDb, PgliteDriver } from './pglite.js';
import { EventStore } from './store.js';

const session = { sessionId: 's1', worktree: '/wt/agent-s1', model: 'claude-opus-4-8' };
const event: AgentEvent = { t: 'text', delta: 'hello' };

describe('createEmbeddedDb — in-memory', () => {
  it('migrates and round-trips a session + events', async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      const store = new EventStore(db);
      await store.createSession(session);
      await store.appendEvent(session.sessionId, event);

      expect(await store.getSession(session.sessionId)).toMatchObject(session);
      expect(await store.getEvents(session.sessionId)).toEqual([event]);
    } finally {
      await db.destroy();
    }
  });

  it('exposes the migrated schema via introspection', async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      const introspected = await db.introspection.getTables();
      const tables = introspected.map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['sessions', 'events', 'transcript_lines']));
      // 0003 added the nullable `name` column to sessions.
      const sessionsColumns = introspected.find((t) => t.name === 'sessions')?.columns ?? [];
      expect(sessionsColumns.map((c) => c.name)).toEqual(expect.arrayContaining(['name']));
      expect(sessionsColumns.find((c) => c.name === 'name')?.isNullable).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('rolls a failed transaction back', async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      await expect(
        db.transaction().execute(async (trx) => {
          await new EventStore(trx).createSession({ ...session, sessionId: 'rolled-back' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(await new EventStore(db).getSession('rolled-back')).toBeUndefined();
    } finally {
      await db.destroy();
    }
  });

  it('serializes a transaction against concurrent work on the shared PGlite session', async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction().execute(async (trx) => {
        await new EventStore(trx).createSession({ ...session, sessionId: 'serialized-a' });
        await gate;
      });
      let concurrentSettled = false;
      const concurrent = db
        .transaction()
        .execute(async (trx) => {
          await new EventStore(trx).createSession({
            ...session,
            sessionId: 'serialized-b',
            worktree: '/tmp/serialized-b',
          });
        })
        .finally(() => {
          concurrentSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(concurrentSettled).toBe(false);
      release();
      await Promise.all([transaction, concurrent]);
      expect(await new EventStore(db).getSession('serialized-b')).toBeDefined();
    } finally {
      await db.destroy();
    }
  });

  it("keeps ordinary queries outside another connection's open transaction", async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = db.transaction().execute(async (trx) => {
        await new EventStore(trx).createSession({ ...session, sessionId: 'uncommitted' });
        await gate;
      });

      let querySettled = false;
      const query = new EventStore(db).getSession('uncommitted').finally(() => {
        querySettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(querySettled).toBe(false);
      release();
      await transaction;
      await expect(query).resolves.toBeDefined();
    } finally {
      await db.destroy();
    }
  });

  it('releases the coordinator when BEGIN fails', async () => {
    let failBegin = true;
    const client = {
      query: (statement: string) => {
        if (statement === 'begin' && failBegin) {
          failBegin = false;
          return Promise.reject(new Error('injected BEGIN failure'));
        }
        return Promise.resolve({ rows: [{ value: 1 }], affectedRows: 0 });
      },
      close: () => Promise.resolve(),
    };
    const driver = new PgliteDriver(client as never);
    const first = await driver.acquireConnection();
    await expect(driver.beginTransaction(first)).rejects.toThrow('injected BEGIN failure');
    // If the failed BEGIN retained the coordinator lock, the next connection's
    // ordinary query would wait forever.
    const second = await driver.acquireConnection();
    await expect(second.executeQuery(CompiledQuery.raw('select 1'))).resolves.toMatchObject({
      rows: [{ value: 1 }],
    });
  });

  it('rejects an empty dataDir (would silently degrade to in-memory + lose data)', () => {
    expect(() => createEmbeddedDb('')).toThrow(/empty/);
    expect(() => createEmbeddedDb('   ')).toThrow(/empty/);
  });

  it('does not support streaming', async () => {
    const db = createEmbeddedDb();
    try {
      await migrateToLatest(db);
      await expect(
        (async () => {
          for await (const _ of db.selectFrom('sessions').selectAll().stream()) {
            void _;
          }
        })(),
      ).rejects.toThrow(/streaming/);
    } finally {
      await db.destroy();
    }
  });
});

describe('createEmbeddedDb — file-backed', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('persists data across a close/reopen of the same dataDir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'verity-pglite-'));

    const first = createEmbeddedDb(dir);
    await migrateToLatest(first);
    const store = new EventStore(first);
    await store.createSession(session);
    await store.appendEvent(session.sessionId, event);
    await first.destroy();

    // Reopen the same directory: the data is still there. migrateToLatest is
    // idempotent, so re-running it on the already-migrated DB is a no-op.
    const second = createEmbeddedDb(dir);
    try {
      await migrateToLatest(second);
      const reopened = new EventStore(second);
      expect(await reopened.getSession(session.sessionId)).toMatchObject(session);
      expect(await reopened.getEvents(session.sessionId)).toEqual([event]);
    } finally {
      await second.destroy();
    }
  });

  it('persists session deletes across a close/reopen of the same dataDir', async () => {
    dir = mkdtempSync(join(tmpdir(), 'verity-pglite-'));

    const first = createEmbeddedDb(dir);
    await migrateToLatest(first);
    const store = new EventStore(first);
    await store.createSession(session);
    await store.appendEvent(session.sessionId, event);
    expect(await store.deleteSession(session.sessionId)).toBe(true);
    await first.destroy();

    const second = createEmbeddedDb(dir);
    try {
      await migrateToLatest(second);
      const reopened = new EventStore(second);
      expect(await reopened.getSession(session.sessionId)).toBeUndefined();
      expect(await reopened.getEvents(session.sessionId)).toEqual([]);
    } finally {
      await second.destroy();
    }
  });
});
