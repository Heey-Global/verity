import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AttachmentUpload } from '@verity/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupTurnImageAttachments,
  stageImageAttachments,
  materializeFileAttachments,
} from './file-attachments.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'verity-file-attach-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('materializeFileAttachments', () => {
  it('is a no-op when there are no attachments', async () => {
    const result = await materializeFileAttachments(cwd, undefined);
    expect(result.promptSuffix).toBe('');
    expect(result.imageAttachments).toBeUndefined();
    await result.cleanup();
  });

  it('passes images through untouched and writes no scratch dir', async () => {
    const image: AttachmentUpload = { kind: 'image', mediaType: 'image/png', data: b64('img') };
    const result = await materializeFileAttachments(cwd, [image]);
    expect(result.promptSuffix).toBe('');
    expect(result.imageAttachments).toEqual([image]);
    expect(readdirSync(cwd)).toHaveLength(0);
    await result.cleanup();
  });

  it('writes file attachments to disk and points the prompt at them', async () => {
    const file: AttachmentUpload = {
      kind: 'file',
      mediaType: 'application/pdf',
      fileName: 'report.pdf',
      data: b64('PDF-BYTES'),
    };
    const result = await materializeFileAttachments(cwd, [file]);

    // The prompt names the on-disk path + media type.
    expect(result.promptSuffix).toContain('report.pdf');
    expect(result.promptSuffix).toContain('application/pdf');
    const match = /- (\S+) \(application\/pdf\)/.exec(result.promptSuffix);
    const path = match?.[1] ?? '';
    expect(path).not.toBe('');
    expect(path.startsWith(`${cwd}/.verity-sessions/attachments/turn-`)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).toString()).toBe('PDF-BYTES');

    // cleanup removes the scratch dir entirely.
    await result.cleanup();
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('separates images (inline) from files (materialized)', async () => {
    const image: AttachmentUpload = { kind: 'image', mediaType: 'image/jpeg', data: b64('jpg') };
    const file: AttachmentUpload = {
      kind: 'file',
      mediaType: 'text/csv',
      fileName: 'data.csv',
      data: b64('a,b,c'),
    };
    const result = await materializeFileAttachments(cwd, [image, file]);
    expect(result.imageAttachments).toEqual([image]);
    expect(result.promptSuffix).toContain('data.csv');
    await result.cleanup();
  });

  it('sanitizes unsafe names and disambiguates collisions', async () => {
    const traversal: AttachmentUpload = {
      kind: 'file',
      mediaType: 'text/plain',
      fileName: '../../etc/passwd',
      data: b64('x'),
    };
    const dupeA: AttachmentUpload = {
      kind: 'file',
      mediaType: 'text/plain',
      fileName: 'notes.txt',
      data: b64('a'),
    };
    const dupeB: AttachmentUpload = {
      kind: 'file',
      mediaType: 'text/plain',
      fileName: 'notes.txt',
      data: b64('b'),
    };
    const result = await materializeFileAttachments(cwd, [traversal, dupeA, dupeB]);

    expect(readdirSync(cwd)).toHaveLength(1);
    const path = /- (\S+) \(text\/plain\)/.exec(result.promptSuffix)?.[1] ?? '';
    const scratch = dirname(path);
    const names = readdirSync(scratch).sort();
    // basename strips the traversal; the duplicate is suffixed.
    expect(names).toContain('passwd');
    expect(names).toContain('notes.txt');
    expect(names).toContain('notes-1.txt');
    await result.cleanup();
  });

  it('cleans through the held parent when the visible parent path is replaced', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'verity-file-attach-outside-'));
    await writeFile(join(outside, 'keep'), 'safe');
    const result = await materializeFileAttachments(cwd, [
      { kind: 'file', mediaType: 'text/plain', fileName: 'note.txt', data: b64('note') },
    ]);
    const attachments = join(cwd, '.verity-sessions', 'attachments');
    const moved = `${attachments}-moved`;
    await rename(attachments, moved);
    await symlink(outside, attachments);
    await result.cleanup();
    expect(existsSync(join(outside, 'keep'))).toBe(true);
    expect(readdirSync(moved)).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });
});

describe('staged image transport', () => {
  it('preserves multiple large originals in compact, retry-stable references', async () => {
    const images: AttachmentUpload[] = [1, 2, 3].map((value) => ({
      kind: 'image',
      mediaType: 'image/png',
      data: Buffer.alloc(2 * 1024 * 1024, value).toString('base64'),
    }));
    const refs = await stageImageAttachments(cwd, 'test-turn', images);
    expect(Buffer.byteLength(JSON.stringify(refs))).toBeLessThan(2048);
    expect(refs).toHaveLength(images.length);
    for (const [index, ref] of (refs ?? []).entries()) {
      expect(readFileSync(ref.filePath).toString('base64')).toBe(images[index]?.data);
    }
    expect(await stageImageAttachments(cwd, 'test-turn', images)).toEqual(refs);
    await cleanupTurnImageAttachments(cwd, 'test-turn');
    await cleanupTurnImageAttachments(cwd, 'test-turn');
    expect(existsSync(refs?.[0]?.filePath ?? '')).toBe(false);
  });

  it('rejects modified retry files and symlinked turn directories', async () => {
    const image: AttachmentUpload = {
      kind: 'image',
      mediaType: 'image/png',
      data: b64('original'),
    };
    const refs = await stageImageAttachments(cwd, 'test-turn', [image]);
    await writeFile(refs?.[0]?.filePath ?? '', 'modified');
    await expect(stageImageAttachments(cwd, 'test-turn', [image])).rejects.toThrow(
      'staged image content changed',
    );
    await symlink(cwd, join(cwd, '.verity-sessions', 'attachments', 'turn-other'));
    await expect(stageImageAttachments(cwd, 'other', [image])).rejects.toThrow();
  });
});
