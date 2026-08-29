import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttachmentUpload } from '@verity/events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeFileAttachments } from './file-attachments.js';

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
    const relPath = match?.[1] ?? '';
    expect(relPath).not.toBe('');
    expect(existsSync(join(cwd, relPath))).toBe(true);
    expect(readFileSync(join(cwd, relPath)).toString()).toBe('PDF-BYTES');

    // cleanup removes the scratch dir entirely.
    await result.cleanup();
    expect(readdirSync(cwd)).toHaveLength(0);
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

    // No path escapes cwd: the scratch dir is the only new entry.
    const roots = readdirSync(cwd);
    expect(roots).toHaveLength(1);
    const scratch = join(cwd, roots[0] ?? '');
    const names = readdirSync(scratch).sort();
    // basename strips the traversal; the duplicate is suffixed.
    expect(names).toContain('passwd');
    expect(names).toContain('notes.txt');
    expect(names).toContain('notes-1.txt');
    await result.cleanup();
  });
});
