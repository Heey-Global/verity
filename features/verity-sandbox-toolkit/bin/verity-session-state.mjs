import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const identifier = (value) => `"${value.replaceAll('"', '""')}"`;

/** Copy native session projections and their event aggregates, never global
 * credentials, account state, shared permissions or unrelated conversations.
 * Unsupported opaque state fails closed; the source remains unchanged. */
export async function migrateOpenCodeSession(sourcePath, targetPath, rootId) {
  const metadata = await lstat(sourcePath).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return { migrated: false, sessionIds: [] };
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Invalid legacy OpenCode database');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let target;
  const temporary = `${targetPath}.${randomUUID()}.migration`;
  try {
    source.exec('BEGIN');
    const schema = source
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name",
      )
      .all();
    const tables = new Map(
      schema.filter((entry) => entry.type === 'table').map((entry) => [entry.name, entry]),
    );
    if (!tables.has('session_v2')) throw new Error('Unsupported legacy OpenCode session schema');
    const allSessions = source.prepare('SELECT id, parent_id FROM session_v2').all();
    if (!allSessions.some((session) => session.id === rootId))
      return { migrated: false, sessionIds: [] };
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const session of allSessions) {
        if (!ids.has(session.id) && ids.has(session.parent_id)) {
          ids.add(session.id);
          changed = true;
        }
      }
    }
    if (tables.has('kv') && source.prepare('SELECT 1 FROM kv LIMIT 1').get())
      throw new Error('Legacy OpenCode has opaque state requiring explicit migration support');
    if (
      await lstat(targetPath).then(
        () => true,
        (error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    ) {
      const existing = new DatabaseSync(targetPath, { readOnly: true });
      try {
        if (!existing.prepare('SELECT id FROM session_v2 WHERE id = ?').get(rootId))
          throw new Error('Existing OpenCode target does not contain the expected native session');
      } finally {
        existing.close();
      }
      return { migrated: false, sessionIds: [...ids] };
    }
    const ownedRows = (table, column, values) => {
      const keys = [...values];
      if (!keys.length) return [];
      return source
        .prepare(
          `SELECT * FROM ${identifier(table)} WHERE ${identifier(column)} IN (${keys.map(() => '?').join(',')})`,
        )
        .all(...keys);
    };
    const selected = ownedRows('session_v2', 'id', ids);
    const projects = new Set(selected.map((session) => session.project_id));
    const workspaces = new Set(selected.map((session) => session.workspace_id).filter(Boolean));
    const rows = new Map();
    const hashes = new Set();
    for (const [name] of tables) {
      const columns = source
        .prepare(`PRAGMA table_info(${identifier(name)})`)
        .all()
        .map((column) => column.name);
      let records = [];
      if (name === 'session_v2') records = selected;
      else if (name === 'migration')
        records = source.prepare(`SELECT * FROM ${identifier(name)}`).all();
      else if (name === 'project') records = ownedRows('project', 'id', projects);
      else if (name === 'workspace') records = ownedRows('workspace', 'id', workspaces);
      else if (columns.includes('session_id')) records = ownedRows(name, 'session_id', ids);
      else if (columns.includes('aggregate_id')) records = ownedRows(name, 'aggregate_id', ids);
      for (const row of records)
        for (const value of Object.values(row)) {
          if (typeof value === 'string')
            for (const match of value.matchAll(/\b[a-f0-9]{64}\b/gu)) hashes.add(match[0]);
        }
      rows.set(name, records);
    }
    if (tables.has('instruction_blob'))
      rows.set('instruction_blob', ownedRows('instruction_blob', 'hash', hashes));
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    target = new DatabaseSync(temporary);
    target.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    for (const [, entry] of tables) target.exec(entry.sql);
    for (const [name, records] of rows) {
      if (!records.length) continue;
      const columns = Object.keys(records[0]);
      const insert = target.prepare(
        `INSERT INTO ${identifier(name)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      for (const row of records) insert.run(...columns.map((column) => row[column]));
    }
    for (const entry of schema) if (entry.type !== 'table') target.exec(entry.sql);
    if (target.prepare('PRAGMA foreign_key_check').all().length)
      throw new Error('OpenCode migration failed foreign-key verification');
    for (const [name, records] of rows)
      if (
        Number(target.prepare(`SELECT count(*) AS count FROM ${identifier(name)}`).get().count) !==
        records.length
      )
        throw new Error('OpenCode migration failed row verification');
    target.exec('COMMIT');
    target.close();
    target = undefined;
    await rename(temporary, targetPath);
    return { migrated: true, sessionIds: [...ids] };
  } finally {
    target?.close();
    source.close();
    await rm(temporary, { force: true });
  }
}

export async function purgeOpenCodeSessions(sourcePath, sessionIds) {
  const metadata = await lstat(sourcePath).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Invalid legacy native database');
  const db = new DatabaseSync(sourcePath);
  try {
    // Session parents and event sequences may precede their children in the schema.
    // Check references at commit after every owned row has been removed.
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((entry) => entry.name);
    const ids = new Set(sessionIds);
    const tree = db.prepare('SELECT id, parent_id FROM session_v2').all();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of tree)
        if (ids.has(row.parent_id) && !ids.has(row.id)) {
          ids.add(row.id);
          changed = true;
        }
    }
    for (const table of tables) {
      const columns = db
        .prepare(`PRAGMA table_info(${identifier(table)})`)
        .all()
        .map((column) => column.name);
      const key =
        table === 'session_v2'
          ? 'id'
          : columns.includes('session_id')
            ? 'session_id'
            : columns.includes('aggregate_id')
              ? 'aggregate_id'
              : undefined;
      if (!key) continue;
      const remove = db.prepare(`DELETE FROM ${identifier(table)} WHERE ${identifier(key)}=?`);
      for (const id of ids) remove.run(id);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new Error('Migration request too large');
  }
  const request = JSON.parse(input);
  try {
    process.stdout.write(
      JSON.stringify(
        request.operation === 'purge'
          ? (await purgeOpenCodeSessions(request.source, request.sessionIds), { purged: true })
          : await migrateOpenCodeSession(request.source, request.target, request.rootId),
      ),
    );
  } catch {
    process.stderr.write('Native OpenCode session migration could not be verified\n');
    process.exitCode = 1;
  }
}
