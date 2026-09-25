import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accepts, jsonSchemas, schemas, type SchemaName } from './schemas.ts';

const fixtures = JSON.parse(
  readFileSync(new URL('./wire-fixtures.json', import.meta.url), 'utf8'),
) as { name: string; schema: SchemaName; valid: boolean; value: unknown }[];

describe('team bootstrap review contract', () => {
  it.each(fixtures)('$name', ({ schema, valid, value }) => {
    expect(accepts(schema, value)).toBe(valid);
  });

  it('exports the checked-in portable schemas from the source definitions', () => {
    const checkedIn = JSON.parse(
      readFileSync(new URL('./wire-schemas.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(checkedIn).toEqual(jsonSchemas());
    expect(Object.keys(checkedIn as object)).toEqual(Object.keys(schemas));
  });

  it('rejects extra fields for every message type', () => {
    for (const fixture of fixtures.filter(({ valid }) => valid)) {
      expect(
        accepts(fixture.schema, { ...(fixture.value as object), unexpected: true }),
        fixture.name,
      ).toBe(false);
    }
  });
});
