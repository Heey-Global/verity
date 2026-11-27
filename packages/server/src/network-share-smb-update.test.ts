import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NetworkShareError, contentVersion } from './network-share-smb.js';
import {
  FAKE_TARGET,
  createFakeShare,
  type Fault,
  type FakeShare,
} from './network-share-smb.test-helper.js';

const original = Buffer.from('original text\n');
const replacement = Buffer.from('new text\n');

// The commands of an update, in order: 1 allinfo, 2 put temporary, 3 rename the
// file aside, 4 get the moved file, 5 rename temporary into place, 6 del aside.
// A restore then runs: rename aside back, del temporary.
const MOVE_ASIDE = 3;
const DOWNLOAD = 4;
const PUBLISH = 5;

let fake: FakeShare;

beforeEach(() => {
  fake = createFakeShare();
  writeFileSync(join(fake.root, 'notes.md'), original);
});

afterEach(() => {
  fake.remove();
});

async function update(plan: Fault[], expected = contentVersion(original)): Promise<unknown> {
  return fake
    .client(plan)
    .update(FAKE_TARGET, 'notes.md', replacement, expected)
    .catch((error: unknown) => error);
}

function code(error: unknown): string | undefined {
  expect(error).toBeInstanceOf(NetworkShareError);
  return (error as NetworkShareError).code;
}

const share = () => fake.entries();

// Each case is a way the replace can be cut short. Whatever happens, the
// original's bytes must stay somewhere on the share, and the agent must be told
// where when they are not under the file's own name; an error that hides a
// moved original invites a fresh write over the gap.
describe('replacing a file on a share', () => {
  it('replaces the file and leaves nothing behind', async () => {
    expect(await update([])).toMatchObject({ version: contentVersion(replacement) });
    expect(share()).toEqual({ 'notes.md': 'new text\n' });
  });

  it('puts the original back when its content changed since it was read', async () => {
    expect(code(await update([], contentVersion(Buffer.from('older'))))).toBe('conflict');
    expect(share()).toEqual({ 'notes.md': 'original text\n' });
  });

  it('puts the original back after the connection dropped before publishing', async () => {
    expect(code(await update([{ at: PUBLISH, drop: 'before' }]))).toBe('unreachable');
    expect(share()).toEqual({ 'notes.md': 'original text\n' });
  });

  it('keeps the file someone created meanwhile and the original under a hidden name', async () => {
    const error = await update([{ at: DOWNLOAD, create: 'notes.md', content: 'theirs\n' }]);
    expect(code(error)).toBe('restore_failed');
    expect((error as Error).message).toContain('.verity-….old');
    expect(share()).toEqual({ 'notes.md': 'theirs\n', old: 'original text\n' });
  });

  it('keeps the original hidden when a conflict cannot be put back', async () => {
    const error = await update(
      [{ at: DOWNLOAD, create: 'notes.md', content: 'theirs\n' }],
      contentVersion(Buffer.from('older')),
    );
    expect(code(error)).toBe('restore_failed');
    expect(share()).toEqual({ 'notes.md': 'theirs\n', old: 'original text\n' });
  });

  it('says the original may be hidden when the share stays out of reach', async () => {
    const error = await update([{ at: MOVE_ASIDE, drop: 'after', stayDown: true }]);
    expect(code(error)).toBe('interrupted');
    expect((error as Error).message).toContain('.verity-….old');
    expect(share()).toEqual({ old: 'original text\n', tmp: 'new text\n' });
  });

  // From outside, a drop just before the move looks like one just after it;
  // the warning must err on the side of the original having moved.
  it('warns the same way when the share drops right before the move', async () => {
    expect(code(await update([{ at: MOVE_ASIDE, drop: 'before', stayDown: true }]))).toBe(
      'interrupted',
    );
    expect(share()).toEqual({ 'notes.md': 'original text\n', tmp: 'new text\n' });
  });
});
