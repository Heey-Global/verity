import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accepts, jsonSchemas, schemas, type SchemaName } from './schemas.js';
import { checkProof, encode, type Transcript } from './model.js';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as unknown;
const fixtures = read('./wire-fixtures.json') as {
  name: string;
  schema: SchemaName;
  value: Record<string, unknown>;
  valid: boolean;
}[];
const vectors = read('./action-vectors.json') as {
  name: string;
  fields: Transcript;
  hex: string;
  signature: string;
}[];

it('keeps the portable schema export synchronized with the executable schemas', () => {
  expect(read('./wire-schemas.json')).toEqual(jsonSchemas());
});
it('covers every exported schema with accepted and rejected wire examples', () => {
  for (const schema of Object.keys(schemas)) {
    expect(
      fixtures.some((f) => f.schema === schema && f.valid),
      schema,
    ).toBe(true);
    expect(
      fixtures.some((f) => f.schema === schema && !f.valid),
      schema,
    ).toBe(true);
  }
});
describe('portable wire fixtures', () => {
  it.each(fixtures)('$name', ({ schema, value, valid }) => {
    expect(accepts(schema, value)).toBe(valid);
  });
});
describe('fixed enrollment action vectors', () => {
  it.each(vectors)(
    '$name matches exact bytes and Ed25519 signature',
    ({ fields, hex, signature }) => {
      expect(encode(fields).toString('hex')).toBe(hex);
      expect(checkProof(fields, signature)).toBe(true);
      for (let index = 0; index < fields.length; index++) {
        const altered = [...fields] as Transcript;
        if (index === 13) altered[13]++;
        else altered[index] = String(altered[index]) + 'x';
        expect(checkProof(altered, signature), 'bound field ' + index).toBe(false);
      }
    },
  );
  it('covers every permitted action/purpose pair from the challenge schema', () => {
    const sample = fixtures.find((f) => f.schema === 'challenge' && f.valid)!.value;
    for (const purpose of ['initial-admin', 'team-member']) {
      for (const action of ['initialize', 'commit', 'recover']) {
        expect(vectors.some((v) => v.fields[1] === action && v.fields[4] === purpose)).toBe(
          accepts('challenge', { ...sample, action, purpose }),
        );
      }
    }
  });
});
