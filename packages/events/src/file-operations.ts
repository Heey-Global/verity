import { z } from 'zod';

const id = z.string().min(1).max(512);
const name = z.string().trim().min(1).max(255);
const targetName = z.string().min(1).max(1024);
const target = { fileId: id.optional(), name: name.optional() };
const content = {
  content: z.string().max(10_000_000),
  encoding: z.enum(['utf8', 'base64']).optional(),
};
const version = z.string().min(1).max(1024);
const identified = <T extends z.ZodType>(schema: T) =>
  schema.refine((request: unknown) => {
    const value = request as { fileId?: string; name?: string };
    return Boolean(value.fileId || value.name);
  }, 'fileId or name required');

function fitsUtf8Limit(text: string): boolean {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > 10_000_000) return false;
  }
  return true;
}
function validBase64(text: string): boolean {
  if (text.length % 4 !== 0) return false;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  // Repeated capture groups overflow V8's regexp stack on accepted large files.
  const unpadded = padding === 0 ? text : text.slice(0, -padding);
  return !/[^A-Za-z0-9+/]/.test(unpadded);
}
const validContent = (value: { content: string; encoding?: string | undefined }) =>
  value.encoding === 'base64' ? validBase64(value.content) : fitsUtf8Limit(value.content);

/** Approval and execution must interpret the same bounded file-operation payload. */
export const fileOperationRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capabilities') }).strict(),
  z
    .object({
      action: z.literal('list'),
      folderId: id.optional(),
      pageToken: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      query: z.string().trim().min(1).max(200),
      pageToken: z.string().min(1).max(4096).optional(),
    })
    .strict(),
  identified(z.object({ action: z.literal('read'), ...target }).strict()),
  z
    .object({
      action: z.literal('upload'),
      name,
      mimeType: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^\r\n]+$/),
      folderId: id.optional(),
      ...content,
    })
    .strict()
    .refine(validContent, 'Content must be valid base64 or at most 10 MB of UTF-8'),
  z.object({ action: z.literal('create_folder'), name, folderId: id.optional() }).strict(),
  z
    .object({
      action: z.literal('overwrite'),
      fileId: id,
      name: targetName,
      expectedVersion: version,
      ...content,
    })
    .strict()
    .refine(validContent, 'Content must be valid base64 or at most 10 MB of UTF-8'),
  z
    .object({
      action: z.literal('rename'),
      fileId: id,
      name: targetName,
      expectedVersion: version,
      newName: name,
    })
    .strict(),
  z
    .object({
      action: z.literal('move'),
      fileId: id,
      name: targetName,
      expectedVersion: version,
      folderId: id,
    })
    .strict(),
  z
    .object({ action: z.literal('trash'), fileId: id, name: targetName, expectedVersion: version })
    .strict(),
]);
