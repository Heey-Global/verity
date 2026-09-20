import { expect, it } from 'vitest';
import type { KnowledgeSource } from '@verity/store';
import { knowledgeToolRequestSchema } from '@verity/events';
import { knowledgeSourceToolResult } from './knowledge-source-tool-result.js';

const source: KnowledgeSource = {
  revisionId: 'revision',
  filename: 'logo.png',
  mediaType: 'image/png',
  bytes: Buffer.from('original'),
  size: 8,
  sha256: 'digest',
  processingState: 'ready',
  processingNote: 'Preview available',
  locators: [],
  previews: [{ label: 'Image', mediaType: 'image/png', base64: 'cHJldmlldw==' }],
};
it('keeps default metadata small and sends selected previews as visible MCP images', () => {
  const request = knowledgeToolRequestSchema.parse({
    operation: 'read_original',
    documentId: 'doc',
    view: 'preview',
    previewIndex: 0,
  });
  if (request.operation !== 'read_original') throw new Error('Unexpected parsed operation');
  expect(knowledgeSourceToolResult({ documentId: 'doc' }, { source }).content).toHaveLength(1);
  expect(knowledgeSourceToolResult(request, { source }).content[1]).toEqual({
    type: 'image',
    mimeType: 'image/png',
    data: source.previews[0]?.base64,
  });
  expect(() =>
    knowledgeSourceToolResult({ documentId: 'doc', view: 'preview', previewIndex: 1 }, { source }),
  ).toThrow('no preview');
});
it('returns exact original bytes as a revision-specific resource only when requested', () => {
  const result = knowledgeSourceToolResult({ documentId: 'doc', view: 'original' }, { source });
  expect(result.content[1]).toEqual({
    type: 'resource',
    resource: {
      uri: 'verity-knowledge://documents/doc/revisions/revision/original',
      mimeType: source.mediaType,
      blob: source.bytes.toString('base64'),
    },
  });
  expect(JSON.stringify(result.content)).not.toContain(source.previews[0]?.base64);
});
