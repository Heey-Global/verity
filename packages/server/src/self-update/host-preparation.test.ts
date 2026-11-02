import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  parseHostPreparation,
  readHostPreparation,
  writeHostPreparation,
} from './host-preparation.js';
import type { UpdateJournal } from './update-journal.js';
const journal = {
  updateId: 'update-1',
  targetDigest: `ghcr.io/heey-global/verity/verity-server@sha256:${'b'.repeat(64)}`,
  phase: 'preflight',
} as UpdateJournal;
describe('backward-compatible host preparation sidecar', () => {
  it('binds durable progress to the operation and only reports it during preflight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-progress-'));
    try {
      expect(await readHostPreparation(root, journal)).toBeNull();
      await writeHostPreparation(root, journal, 'renewing');
      expect(await readHostPreparation(root, journal)).toMatchObject({
        stage: 'renewing',
        updateId: journal.updateId,
      });
      expect(await readHostPreparation(root, { ...journal, updateId: 'different' })).toBeNull();
      expect(await readHostPreparation(root, { ...journal, phase: 'standby' })).toBeNull();
      await writeFile(join(root, 'host-preparation.json'), 'not json');
      expect(await readHostPreparation(root, journal)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects widened or invalid progress records', () => {
    const record = {
      updateId: journal.updateId,
      targetDigest: journal.targetDigest,
      stage: 'renewing',
    };
    expect(parseHostPreparation(record)).not.toBeNull();
    expect(parseHostPreparation({ ...record, stage: 'restart-docker' })).toBeNull();
    expect(parseHostPreparation({ ...record, command: 'untrusted' })).toBeNull();
  });
});
