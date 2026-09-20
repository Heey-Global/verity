import { describe, expect, it } from 'vitest';
import { knowledgeToolRequestSchema } from './knowledge-tool.js';

describe('knowledge tool boundary', () => {
  it('requires a revision for edits and refuses caller-supplied authority', () => {
    const edit = { operation: 'edit', documentId: 'doc', title: 'Notes', bodyMarkdown: 'text' };
    expect(knowledgeToolRequestSchema.safeParse(edit).success).toBe(false);
    expect(
      knowledgeToolRequestSchema.safeParse({ ...edit, expectedRevisionId: 'rev' }).success,
    ).toBe(true);
    expect(
      knowledgeToolRequestSchema.safeParse({ operation: 'list', projectId: 'other' }).success,
    ).toBe(false);
    expect(
      knowledgeToolRequestSchema.safeParse({
        operation: 'read',
        documentId: 'doc',
        sessionId: 'other',
      }).success,
    ).toBe(false);
  });

  it('does not expose hierarchy or destructive operations to agents', () => {
    for (const operation of ['delete', 'move', 'restore', 'create_folder', 'grant']) {
      expect(knowledgeToolRequestSchema.safeParse({ operation, documentId: 'doc' }).success).toBe(
        false,
      );
    }
  });
});

it('bounds pagination while accepting a selected folder for search', () => {
  expect(
    knowledgeToolRequestSchema.safeParse({
      operation: 'search',
      query: 'notes',
      folderId: 'folder',
      offset: 100,
      limit: 100,
    }).success,
  ).toBe(true);
  expect(knowledgeToolRequestSchema.safeParse({ operation: 'list', limit: 101 }).success).toBe(
    false,
  );
  expect(
    knowledgeToolRequestSchema.safeParse({ operation: 'search', query: 'notes', offset: -1 })
      .success,
  ).toBe(false);
});
