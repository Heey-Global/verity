import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemas as bootstrapSchemas } from '../team-bootstrap-contract/schemas.ts';
import { schemas as enrollmentSchemas } from '../enrollment-proof/schemas.ts';
import { accepts, errorCodes, jsonSchemas, schemas, type SchemaName } from './schemas.ts';

const fixtures = JSON.parse(
  readFileSync(new URL('./wire-fixtures.json', import.meta.url), 'utf8'),
) as { name: string; schema: SchemaName; valid: boolean; value: Record<string, unknown> }[];

describe('team control review contract', () => {
  it.each(fixtures)('$name', ({ schema, valid, value }) => {
    expect(accepts(schema, value)).toBe(valid);
  });

  it('has a valid and an invalid fixture for every schema', () => {
    for (const name of Object.keys(schemas)) {
      const cases = fixtures.filter((fixture) => fixture.schema === name);
      expect(
        cases.some(({ valid }) => valid),
        `${name} valid`,
      ).toBe(true);
      expect(
        cases.some(({ valid }) => !valid),
        `${name} invalid`,
      ).toBe(true);
    }
  });

  it('exports the checked-in portable schemas from the source definitions', () => {
    const checkedIn = JSON.parse(
      readFileSync(new URL('./wire-schemas.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(checkedIn).toEqual(jsonSchemas());
  });

  // Strict objects are the forward-compatibility rule: a new field needs a new
  // team version. A lenient parser would let a newer peer smuggle authority.
  it('rejects extra fields for every message type', () => {
    for (const fixture of fixtures.filter(({ valid }) => valid)) {
      expect(accepts(fixture.schema, { ...fixture.value, unexpected: true }), fixture.name).toBe(
        false,
      );
    }
  });

  // The prose list is what both implementations are reviewed against; a code
  // added here but not there would be emitted by one side and unknown to the other.
  it('uses exactly the error codes the team protocol documents', () => {
    const doc = readFileSync(
      new URL('../../docs/protocols/uplink-team-sharing-v1.md', import.meta.url),
      'utf8',
    );
    const paragraph =
      /`retryable` and optional integer `retryAfterSeconds`\. Codes:\n([\s\S]*?)\. Unknown codes/u.exec(
        doc,
      )?.[1];
    expect(paragraph).toBeDefined();
    expect([...paragraph!.matchAll(/`([a-z_]+)`/gu)].map((match) => match[1])).toEqual([
      ...errorCodes,
    ]);
  });

  // The invitation id travels in the link, the bootstrap reservation and the
  // enrollment proof. If one contract accepted a shorter id, an unauthenticated
  // caller could guess invitations through that path.
  it('uses one unguessable invitation id format across team contracts', () => {
    const invitationId = fixtures.find(({ schema, valid }) => schema === 'invitationLink' && valid)!
      .value['invitationId'];
    const reserve = {
      type: 'team.join.reserve',
      requestId: 'request_1',
      installationHandle: 'AQEBAQEBAQEBAQEBAQEBAQ',
      capabilities: ['team-bootstrap-v1'],
    };
    expect(bootstrapSchemas.joinReserve.safeParse({ ...reserve, invitationId }).success).toBe(true);
    expect(
      bootstrapSchemas.joinReserve.safeParse({ ...reserve, invitationId: 'invite_1' }).success,
    ).toBe(false);
    expect(
      enrollmentSchemas.challenge.safeParse({
        operationId: invitationId,
        invitationId: 'invite_1',
        deviceKey: fixtures.find(({ schema }) => schema === 'invitationLink')!.value['identityKey'],
        purpose: 'team-member',
        action: 'commit',
      }).success,
    ).toBe(false);
  });
});
