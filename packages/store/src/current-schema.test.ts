import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import ts from 'typescript';
import { expect, it } from 'vitest';

import { migrateToLatest } from './db.js';
import { createRawDb } from './testing.js';

it('creates exactly the tables and columns the runtime store declares', async () => {
  const source = ts.createSourceFile(
    'schema.ts',
    readFileSync(new URL('./schema.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const interfaces = new Map(
    source.statements.filter(ts.isInterfaceDeclaration).map((node) => [node.name.text, node]),
  );
  const database = interfaces.get('Database');
  expect(database).toBeDefined();
  const expected: Record<string, string[]> = {};
  for (const member of database!.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type))
      throw new Error('Database must map tables to named interfaces');
    const columns = interfaces.get(member.type.typeName.getText(source));
    if (!columns) throw new Error(`Missing table interface: ${member.type.getText(source)}`);
    expected[member.name.getText(source)] = columns.members
      .map((column) => column.name!.getText(source))
      .sort();
  }

  // A missing SQL column can stay invisible until a rarely used feature writes it.
  // Derive the complete expected shape from the runtime contract, not a second list.
  const { db, close } = createRawDb();
  try {
    await migrateToLatest(db);
    const actual: Record<string, string[]> = {};
    for (const table of await db.introspection.getTables()) {
      if (table.name.startsWith('kysely_')) continue;
      actual[table.name] = table.columns.map((column) => column.name).sort();
    }
    expect(actual).toEqual(expected);
    expect(
      (
        await sql<{ role: string }>`select role from knowledge_folders order by role`.execute(db)
      ).rows.map((row) => row.role),
    ).toEqual(['general', 'sources', 'wiki']);
    expect(
      (
        await sql<{ sequence: string }>`select sequence from live_meeting_sync_clock`.execute(db)
      ).rows.map((row) => Number(row.sequence)),
    ).toEqual([0]);
  } finally {
    await close();
  }
});
