import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  attachmentUploadSchema,
  imageMediaTypeSchema,
  type AttachmentUpload,
} from '@verity/events';
import { z } from 'zod';

const MAX_REFERENCED_IMAGE_BYTES = 7_500_000;
export const imageReferenceSchema = z.strictObject({
  kind: z.literal('image'),
  mediaType: imageMediaTypeSchema,
  filePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => path.startsWith('/')),
  byteSize: z.number().int().min(1).max(MAX_REFERENCED_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ImageReference = z.infer<typeof imageReferenceSchema>;

/** Open each component by descriptor so a directory swap cannot redirect image reads. */
async function loadImage(cwd: string, turnId: string, reference: ImageReference): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(turnId)) throw new Error('invalid image turn');
  const root = resolve(cwd);
  const path = resolve(reference.filePath);
  const parts = relative(root, path).split(sep);
  if (
    parts.length !== 4 ||
    parts[0] !== '.verity-sessions' ||
    parts[1] !== 'attachments' ||
    parts[2] !== `turn-${turnId}` ||
    !parts[3] ||
    parts[3] === '.' ||
    parts[3] === '..'
  )
    throw new Error('image reference outside turn directory');
  const handles: FileHandle[] = [];
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('symlinked image root');
    let handle = await open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(handle);
    for (const [index, component] of parts.entries()) {
      if ((await lstat(`/proc/self/fd/${handle.fd}/${component}`)).isSymbolicLink())
        throw new Error('symlinked image reference');
      handle = await open(
        `/proc/self/fd/${handle.fd}/${component}`,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (index < parts.length - 1 ? constants.O_DIRECTORY : constants.O_NONBLOCK),
      );
      handles.push(handle);
    }
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== reference.byteSize)
      throw new Error('image reference size mismatch');
    // A bounded read also rejects a file that grows after stat, without allocating its new size.
    const bytes = Buffer.alloc(reference.byteSize + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== reference.byteSize) throw new Error('image reference size mismatch');
    const content = bytes.subarray(0, offset);
    if (createHash('sha256').update(content).digest('hex') !== reference.sha256)
      throw new Error('image reference checksum mismatch');
    return content.toString('base64');
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export async function hydrateImageAttachments(
  cwd: string,
  turnId: string,
  attachments: readonly unknown[] | undefined,
): Promise<AttachmentUpload[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length > 20) throw new Error('too many image attachments');
  const result: AttachmentUpload[] = [];
  for (const attachment of attachments) {
    if (typeof attachment === 'object' && attachment !== null && 'filePath' in attachment) {
      const reference = imageReferenceSchema.parse(attachment);
      result.push({
        kind: 'image',
        mediaType: reference.mediaType,
        data: await loadImage(cwd, turnId, reference),
      });
    } else result.push(attachmentUploadSchema.parse(attachment));
  }
  return result;
}
