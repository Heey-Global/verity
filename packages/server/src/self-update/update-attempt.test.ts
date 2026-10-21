import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DockerError } from '../docker.js';
import {
  UPDATE_ATTEMPT_FILE,
  UPDATER_STALL_MS,
  classifyUpdateError,
  clearUpdateAttempt,
  isStalledOperation,
  parseUpdateAttempt,
  readUpdateAttempt,
  writeUpdateAttempt,
  type UpdateAttempt,
} from './update-attempt.js';

const attempt: UpdateAttempt = {
  updateId: 'update-155',
  failures: 3,
  lastAttemptAt: '2026-10-20T21:42:00.000Z',
  lastError: { phase: 'reconciling-companions', cause: 'network-timeout' },
};

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verity-update-attempt-'));
  await chmod(root, 0o700);
  return root;
}

describe('classifyUpdateError', () => {
  // The production incident: a companion image pull whose blob download timed
  // out. The message names a registry host and address; only the cause may leave.
  it('reduces a registry dial timeout to a closed cause', () => {
    const error = new Error('pull failed', {
      cause: new Error('Get "https://ghcr.io/v2/…": dial tcp 140.82.0.1:443: i/o timeout'),
    });
    expect(classifyUpdateError(error)).toBe('network-timeout');
  });

  it.each([
    ['dial tcp: lookup ghcr.io: no such host', 'network'],
    ['write /var/lib/docker/tmp: no space left on device', 'disk-full'],
    ['pull access denied for ghcr.io/x, repository does not exist', 'registry'],
    ['managed Gateway exited during startup', 'unhealthy'],
    ['something nobody anticipated', 'unknown'],
  ] as const)('classifies %s as %s', (message, cause) => {
    expect(classifyUpdateError(new Error(message))).toBe(cause);
  });

  it('falls back to the Docker error kind when the message says nothing', () => {
    expect(classifyUpdateError(new DockerError({ kind: 'network', cause: 'EPIPE' }))).toBe(
      'network',
    );
    expect(classifyUpdateError(new DockerError({ kind: 'conflict', message: 'busy' }))).toBe(
      'docker',
    );
  });
});

describe('parseUpdateAttempt', () => {
  it('accepts the closed shape and nothing wider', () => {
    expect(parseUpdateAttempt(attempt)).toEqual(attempt);
    expect(parseUpdateAttempt({ ...attempt, lastError: null })).toMatchObject({ lastError: null });
    // A free-form message is exactly what the closed shape exists to keep out.
    expect(
      parseUpdateAttempt({ ...attempt, lastError: { ...attempt.lastError, message: 'x' } }),
    ).toBeNull();
    expect(
      parseUpdateAttempt({
        ...attempt,
        lastError: { phase: 'reconciling-companions', cause: 'x' },
      }),
    ).toBeNull();
    expect(parseUpdateAttempt({ ...attempt, extra: true })).toBeNull();
    expect(parseUpdateAttempt({ ...attempt, lastAttemptAt: 'yesterday' })).toBeNull();
  });
});

describe('update attempt record', () => {
  it('round-trips privately and clears idempotently', async () => {
    const root = await privateRoot();
    expect(await readUpdateAttempt(root)).toBeNull();
    await writeUpdateAttempt(root, attempt);
    expect(await readUpdateAttempt(root)).toEqual(attempt);
    await clearUpdateAttempt(root);
    await clearUpdateAttempt(root);
    expect(await readUpdateAttempt(root)).toBeNull();
  });

  // Diagnostics must never take the status route down with them.
  it('reads a corrupt record as nothing recorded', async () => {
    const root = await privateRoot();
    await writeFile(join(root, UPDATE_ATTEMPT_FILE), '{"updateId":', { mode: 0o600 });
    expect(await readUpdateAttempt(root)).toBeNull();
  });

  it('refuses to write a record outside the closed shape', async () => {
    const root = await privateRoot();
    await expect(writeUpdateAttempt(root, { ...attempt, failures: -1 })).rejects.toThrow('invalid');
    await expect(readFile(join(root, UPDATE_ATTEMPT_FILE))).rejects.toThrow();
  });
});

describe('isStalledOperation', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z');
  const at = (ms: number) => new Date(now - ms).toISOString();

  it('needs a non-terminal state that has not moved for the threshold', () => {
    expect(
      isStalledOperation({ state: 'activating', updatedAt: at(UPDATER_STALL_MS + 1) }, now),
    ).toBe(true);
    expect(isStalledOperation({ state: 'activating', updatedAt: at(UPDATER_STALL_MS) }, now)).toBe(
      false,
    );
    expect(isStalledOperation({ state: 'failed', updatedAt: at(UPDATER_STALL_MS * 10) }, now)).toBe(
      false,
    );
    expect(isStalledOperation({ state: 'activating', updatedAt: 'not a time' }, now)).toBe(false);
  });
});
