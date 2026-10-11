import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hydrateImageAttachments, type ImageReference } from './image-references.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(bytes = Buffer.from('original image bytes')) {
  const cwd = await mkdtemp(join(tmpdir(), 'verity-image-ref-'));
  roots.push(cwd);
  const dir = join(cwd, '.verity-sessions', 'attachments', 'turn-test');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'image');
  await writeFile(filePath, bytes);
  const reference: ImageReference = {
    kind: 'image',
    mediaType: 'image/png',
    filePath,
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { cwd, reference, bytes, dir };
}
describe('runner image references', () => {
  it('hydrates multiple images larger than the transport limit without changing bytes', async () => {
    const { cwd, reference, bytes } = await fixture(Buffer.alloc(3 * 1024 * 1024, 42));
    const hydrated = await hydrateImageAttachments(cwd, 'test', [reference, reference]);
    expect(hydrated).toHaveLength(2);
    for (const image of hydrated ?? []) expect(image.data).toBe(bytes.toString('base64'));
  });
  it('rejects changed content and mismatched size', async () => {
    const { cwd, reference } = await fixture();
    await expect(
      hydrateImageAttachments(cwd, 'test', [{ ...reference, byteSize: reference.byteSize - 1 }]),
    ).rejects.toThrow('size mismatch');
    await writeFile(reference.filePath, Buffer.alloc(reference.byteSize));
    await expect(hydrateImageAttachments(cwd, 'test', [reference])).rejects.toThrow(
      'checksum mismatch',
    );
  });
  it('rejects another turn and symlinked files or directories', async () => {
    const { cwd, reference, dir } = await fixture();
    await expect(hydrateImageAttachments(cwd, 'other', [reference])).rejects.toThrow(
      'outside turn',
    );
    const link = join(dir, 'link');
    await symlink(reference.filePath, link);
    await expect(
      hydrateImageAttachments(cwd, 'test', [{ ...reference, filePath: link }]),
    ).rejects.toThrow();
    const moved = join(cwd, 'outside');
    await mkdir(moved);
    await rm(dir, { recursive: true });
    await symlink(moved, dir);
    await expect(hydrateImageAttachments(cwd, 'test', [reference])).rejects.toThrow();
  });
});
