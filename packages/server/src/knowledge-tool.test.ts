import { describe, expect, it } from 'vitest';
import { knowledgeToolRequestSchema } from './knowledge-tool.js';

describe('knowledge tool boundary', () => {
  it('accepts a bounded project source import and rejects destination traversal', () => {
    expect(
      knowledgeToolRequestSchema.parse({
        operation: 'import_source',
        sourcePath: 'docs/meetings/planning.md',
        destination: 'meetings',
        path: 'planning.md',
      }),
    ).toMatchObject({ operation: 'import_source', destination: 'meetings' });
    for (const path of ['../planning.md', 'nested/planning.md', '.']) {
      expect(
        knowledgeToolRequestSchema.safeParse({
          operation: 'import_source',
          sourcePath: 'docs/meetings/planning.md',
          destination: 'meetings',
          path,
        }).success,
      ).toBe(false);
    }
  });

  it('accepts a bounded Shared insight publication', () => {
    expect(
      knowledgeToolRequestSchema.parse({
        operation: 'publish_shared',
        path: 'coaching/profile.md',
        sharedPath: 'coaching/profile.md',
        expectedDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ operation: 'publish_shared', path: 'coaching/profile.md' });
  });

  it('refuses caller-supplied authority', () => {
    expect(
      knowledgeToolRequestSchema.safeParse({
        operation: 'publish_shared',
        path: 'profile.md',
        projectId: 'other',
      }).success,
    ).toBe(false);
  });

  // The retired database library answered these with Wiki-era errors that sent
  // agents looking for a Wiki action which no longer exists. Knowledge is the
  // `/knowledge` directory now; none of them may come back through this tool.
  it('does not expose the retired managed-library operations', () => {
    // Each payload is one the retired schema accepted, so only the missing
    // operation, not a stray field, can make it fail.
    for (const request of [
      { operation: 'list' },
      { operation: 'search', query: 'notes' },
      { operation: 'read', documentId: 'doc' },
      { operation: 'read_original', documentId: 'doc' },
      { operation: 'create', folderId: 'folder', title: 'Notes', bodyMarkdown: 'text' },
      {
        operation: 'edit',
        documentId: 'doc',
        expectedRevisionId: 'rev',
        title: 'Notes',
        bodyMarkdown: 'text',
      },
    ]) {
      expect(knowledgeToolRequestSchema.safeParse(request).success).toBe(false);
    }
  });
});
