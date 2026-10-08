import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { knowledgePublishSummary } from './knowledgePublishSummary.js';

describe('knowledgePublishSummary', () => {
  it('shows the project source and default shared destination', () => {
    expect(
      knowledgePublishSummary({ operation: 'publish_shared', path: 'team/process.md' }),
    ).toEqual({
      source: '/knowledge/insights/team/process.md',
      destination: '/knowledge/shared/insights/team/process.md',
      replacesExisting: false,
    });
  });

  it('identifies an explicit destination and replacement request', () => {
    expect(
      knowledgePublishSummary({
        operation: 'publish_shared',
        path: 'team/process.md',
        sharedPath: 'process.md',
        expectedDigest: 'a'.repeat(64),
      }),
    ).toEqual({
      source: '/knowledge/insights/team/process.md',
      destination: '/knowledge/shared/insights/process.md',
      replacesExisting: true,
    });
  });

  it.each([
    null,
    [],
    {},
    { operation: 'publish_shared' },
    { operation: 'import_source' },
    {
      operation: 'publish_shared',
      path: 'process.md',
      expectedDigest: 'invalid',
    },
  ])('leaves unreadable requests to the raw-input fallback: %j', (input) => {
    expect(knowledgePublishSummary(input)).toBeNull();
  });
});

// A tool rename must not silently reduce the approval to its generic tool name again.
it('recognizes the registered Knowledge tool in the approval card', () => {
  const gateway = readFileSync(
    new URL('../../../server/src/mcp-gateway.ts', import.meta.url),
    'utf8',
  );
  const registeredName = gateway.match(/(\w+): knowledgeToolRequestSchema/)?.[1];
  expect(registeredName).toBeDefined();
  const screen = readFileSync(
    new URL('../../../../apps/mobile/app/session/[id].tsx', import.meta.url),
    'utf8',
  );
  expect(screen.match(/const isKnowledge = pending\.tool === '([^']+)'/)?.[1]).toBe(registeredName);
});
