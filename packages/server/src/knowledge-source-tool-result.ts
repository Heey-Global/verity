import { KnowledgeError, type KnowledgeSource } from '@verity/store';
import { richMcpToolResult, type RichMcpToolResult } from './mcp-tool-result.js';

/** Called only after runAgent has authorized and audited this exact source revision. */
export function knowledgeSourceToolResult(
  input: {
    documentId: string;
    view?: 'metadata' | 'preview' | 'original' | undefined;
    previewIndex?: number | undefined;
  },
  value: unknown,
): RichMcpToolResult {
  if (!value || typeof value !== 'object' || !('source' in value))
    throw new Error('Missing authorized source');
  const source = value.source as KnowledgeSource;
  if (!Buffer.isBuffer(source.bytes)) throw new Error('Invalid authorized source bytes');
  const summary = {
    documentId: input.documentId,
    revisionId: source.revisionId,
    filename: source.filename,
    mediaType: source.mediaType,
    size: source.size,
    sha256: source.sha256,
    processingState: source.processingState,
    processingNote: source.processingNote,
    locators: source.locators.map(({ label }) => label),
    previews: source.previews.map(({ label }, index) => ({ index, label })),
  };
  const content: unknown[] = [{ type: 'text', text: JSON.stringify(summary) }];
  if (input.view === 'preview') {
    const preview = source.previews[input.previewIndex ?? 0];
    if (!preview)
      throw new KnowledgeError(
        'invalid',
        'This source has no preview at the requested index; use the original or extracted text',
      );
    content.push({ type: 'image', mimeType: preview.mediaType, data: preview.base64 });
  } else if (input.view === 'original') {
    content.push({
      type: 'resource',
      resource: {
        uri: `verity-knowledge://documents/${encodeURIComponent(input.documentId)}/revisions/${encodeURIComponent(source.revisionId)}/original`,
        mimeType: source.mediaType,
        blob: source.bytes.toString('base64'),
      },
    });
  }
  return richMcpToolResult(content);
}
