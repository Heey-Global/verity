import { expect, it } from 'vitest';
import { fileOperationRequestSchema } from './file-operations.js';

it('does not permit an agent to self-approve a file mutation', () => {
  expect(
    fileOperationRequestSchema.safeParse({
      action: 'trash',
      fileId: 'file',
      name: 'Note',
      expectedVersion: 'v1',
      approvedByCard: true,
    }).success,
  ).toBe(false);
});
it('requires a version and preserves the exact target name for confirmation', () => {
  expect(
    fileOperationRequestSchema.safeParse({ action: 'trash', fileId: 'file', name: 'Note' }).success,
  ).toBe(false);
  expect(
    fileOperationRequestSchema.parse({
      action: 'trash',
      fileId: 'file',
      name: ' Note ',
      expectedVersion: 'v1',
    }),
  ).toMatchObject({ name: ' Note ' });
});
it('bounds UTF-8 bytes rather than accepting oversized multibyte writes', () => {
  const payload = { action: 'upload', name: 'New', mimeType: 'text/plain' };
  expect(
    fileOperationRequestSchema.safeParse({ ...payload, content: 'é'.repeat(5_000_001) }).success,
  ).toBe(false);
  expect(
    fileOperationRequestSchema.safeParse({ ...payload, content: 'é'.repeat(5_000_000) }).success,
  ).toBe(true);
});
it('rejects malformed base64 instead of silently writing truncated bytes', () => {
  expect(
    fileOperationRequestSchema.safeParse({
      action: 'upload',
      name: 'New',
      mimeType: 'application/octet-stream',
      content: 'broken!!!',
      encoding: 'base64',
    }).success,
  ).toBe(false);
});
