import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accepts, jsonSchemas, schemas, type SchemaName } from './schemas.ts';
import { initialState, step, type Event } from './lifecycle.ts';

const fixtures = JSON.parse(
  readFileSync(new URL('./wire-fixtures.json', import.meta.url), 'utf8'),
) as { name: string; schema: SchemaName; valid: boolean; value: unknown }[];
const lifecycleFixtures = JSON.parse(
  readFileSync(new URL('./lifecycle-fixtures.json', import.meta.url), 'utf8'),
) as { name: string; events: Event[]; phase: string; ticketPairs: number }[];

describe('personal Remote Control review contract', () => {
  it.each(fixtures)('$name', ({ schema, valid, value }) => {
    expect(accepts(schema, value)).toBe(valid);
  });

  it('exports the checked-in portable schemas', () => {
    expect(
      JSON.parse(readFileSync(new URL('./wire-schemas.json', import.meta.url), 'utf8')),
    ).toEqual(jsonSchemas());
    expect(new Set(fixtures.map(({ schema }) => schema))).toEqual(new Set(Object.keys(schemas)));
  });

  it('rejects extra fields on complete messages', () => {
    for (const fixture of fixtures.filter(
      ({ valid, schema }) => valid && schema !== 'negotiation',
    )) {
      expect(
        accepts(fixture.schema, { ...(fixture.value as object), unexpected: true }),
        fixture.name,
      ).toBe(false);
    }
  });

  it('rejects a trailing newline in every opaque identifier and ticket', () => {
    for (const fixture of fixtures.filter(
      ({ valid, schema }) => valid && schema !== 'negotiation',
    )) {
      for (const [key, item] of Object.entries(fixture.value as Record<string, unknown>)) {
        if (['requestId', 'sessionId', 'streamId', 'installationHandle', 'ticket'].includes(key)) {
          expect(
            accepts(fixture.schema, { ...(fixture.value as object), [key]: `${String(item)}\n` }),
            `${fixture.name}.${key}`,
          ).toBe(false);
        }
      }
    }
  });

  it('rejects trailing newlines in capability names and payloads', () => {
    expect(accepts('negotiation', { capabilities: ['remote-control-v1\n'] })).toBe(false);
    expect(
      accepts('connect', {
        type: 'connect',
        requestId: 'request_example',
        installationHandle: 'handle_example',
        capabilities: ['remote-control-v1\n'],
      }),
    ).toBe(false);
    expect(
      accepts('streamData', {
        type: 'stream.data',
        streamId: 'stream_example',
        seq: 0,
        payload: 'AQID\n',
      }),
    ).toBe(false);
  });

  it('enforces the decoded chunk bound and canonical padding bits', () => {
    const frame = { type: 'stream.data', streamId: 'stream_example', seq: 0 };
    expect(
      accepts('streamData', { ...frame, payload: Buffer.alloc(65_536).toString('base64') }),
    ).toBe(true);
    expect(
      accepts('streamData', { ...frame, payload: Buffer.alloc(65_537).toString('base64') }),
    ).toBe(false);
    expect(accepts('streamData', { ...frame, payload: 'AR==' })).toBe(false);
  });
});

describe('personal Remote Control lifecycle contract', () => {
  it.each(lifecycleFixtures)('$name', ({ events, phase, ticketPairs }) => {
    const result = events.reduce(step, initialState);
    expect(result.phase).toBe(phase);
    expect(result.ticketPairs).toBe(ticketPairs);
    if (phase === 'terminal') {
      expect(result.appAttached).toBe(false);
      expect(result.installationAttached).toBe(false);
    }
  });
});
