import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import ts from 'typescript';
import { expect, it } from 'vitest';

import { migrateToLatest } from './db.js';
import { createRawDb } from './testing.js';

it('creates exactly the tables and columns the runtime store declares', async () => {
  // `Database` and the interfaces it extends may live in several schema modules.
  // Literal URLs, not built in a loop: tools that trace file use read them.
  const sources = [
    new URL('./schema.ts', import.meta.url),
    new URL('./schema-assistant.ts', import.meta.url),
    new URL('./schema-brokered-approvals.ts', import.meta.url),
    new URL('./schema-people.ts', import.meta.url),
    new URL('./schema-project-inquiries.ts', import.meta.url),
    new URL('./schema-sandbox.ts', import.meta.url),
    new URL('./schema-session-coordination.ts', import.meta.url),
  ].map((file) =>
    ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true),
  );
  const interfaces = new Map(
    sources.flatMap((source) =>
      source.statements
        .filter(ts.isInterfaceDeclaration)
        .map((node) => [node.name.text, node] as const),
    ),
  );
  const database = interfaces.get('Database');
  expect(database).toBeDefined();
  const tableMaps = [
    database!,
    ...(database!.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type) => {
        const base = interfaces.get(type.expression.getText());
        if (!base) throw new Error(`Missing Database base interface: ${type.getText()}`);
        return base;
      }),
    ),
  ];
  const expected: Record<string, string[]> = {};
  for (const member of tableMaps.flatMap((map) => map.members)) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeReferenceNode(member.type))
      throw new Error('Database must map tables to named interfaces');
    const columns = interfaces.get(member.type.typeName.getText());
    if (!columns) throw new Error(`Missing table interface: ${member.type.getText()}`);
    expected[member.name.getText()] = columns.members
      .map((column) => column.name!.getText())
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
