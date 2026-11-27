import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDevcontainerBuildSnapshot } from './devcontainer-build-boundary.js';
import {
  buildSourceCheck,
  captureDevcontainerBuildEvidence,
  checkoutBuildCommit,
} from './devcontainer-build-evidence.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'verity-build-evidence-'));
  roots.push(root);
  mkdirSync(join(root, '.devcontainer'));
  writeFileSync(join(root, '.devcontainer/devcontainer.json'), '{"image":"alpine"}');
  writeFileSync(join(root, 'input'), 'before');
  const snapshot = await createDevcontainerBuildSnapshot(root);
  roots.push(snapshot.workspaceFolder);
  return { root, snapshot, evidence: await captureDevcontainerBuildEvidence(snapshot) };
}

describe('devcontainer build evidence', () => {
  it('accepts unchanged inputs and creates an opaque identifier per attempt', async () => {
    const { root, snapshot, evidence } = await fixture();
    await expect(evidence.assertSourceUnchanged(root)).resolves.toBeUndefined();
    expect(evidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await captureDevcontainerBuildEvidence(snapshot)).fingerprint).not.toBe(
      evidence.fingerprint,
    );
  });

  it('detects equal-length edits even with the original modification timestamp', async () => {
    const { root, evidence } = await fixture();
    const original = statSync(join(root, 'input'));
    writeFileSync(join(root, 'input'), 'edited');
    utimesSync(join(root, 'input'), original.atime, original.mtime);
    await expect(evidence.assertSourceUnchanged(root)).rejects.toThrow(
      'inputs changed before setup',
    );
  });

  it.each(['remove', 'add', 'mode', 'link'] as const)(
    'detects a relevant %s change',
    async (change) => {
      const { root, evidence } = await fixture();
      if (change === 'remove') rmSync(join(root, 'input'));
      if (change === 'add') writeFileSync(join(root, 'another'), 'new');
      if (change === 'mode') chmodSync(join(root, 'input'), 0o755);
      if (change === 'link') {
        rmSync(join(root, 'input'));
        symlinkSync('.devcontainer/devcontainer.json', join(root, 'input'));
      }
      await expect(evidence.assertSourceUnchanged(root)).rejects.toThrow(
        'inputs changed before setup',
      );
    },
  );

  it('ignores excluded session worktrees and configuration injected after capture', async () => {
    const { root, snapshot, evidence } = await fixture();
    mkdirSync(join(root, '.verity-sessions'));
    writeFileSync(join(root, '.verity-sessions/irrelevant'), 'ignored');
    writeFileSync(snapshot.configFile, '{"image":"server-injected"}');
    await expect(evidence.assertSourceUnchanged(root)).resolves.toBeUndefined();
  });
});

describe('tracked build evidence', () => {
  it('uses unstaged and staged bytes while ignoring unrelated untracked files and normalized permissions', async () => {
    const { root } = await fixture();
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
    writeFileSync(join(root, 'input'), 'dirty!');
    chmodSync(join(root, 'input'), 0o600);
    const snapshot = await createDevcontainerBuildSnapshot(root);
    roots.push(snapshot.workspaceFolder);
    const evidence = await captureDevcontainerBuildEvidence(snapshot);
    writeFileSync(join(root, 'untracked'), 'irrelevant');
    chmodSync(join(root, 'input'), 0o644);
    await expect(evidence.assertSourceUnchanged(root)).resolves.toBeUndefined();
    writeFileSync(join(root, 'input'), 'staged');
    git('add', 'input');
    await expect(evidence.assertSourceUnchanged(root)).rejects.toThrow(
      'inputs changed before setup',
    );
  });
});

describe('build source check storage', () => {
  it.each([false, true])('releases admitted storage after changed=%s', async (changed) => {
    const { root, evidence } = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'verity-evidence-storage-'));
    roots.push(directory);
    const lease = {
      directory,
      retainArtifacts: false,
      reserveBuild: vi.fn(),
      run: vi.fn(async () => ({ stdout: '', stderr: '' })),
      dispose: vi.fn(),
    };
    const storage = { admitInTurn: vi.fn(async () => lease) };
    const owner = { label: 'project/repository', projectId: 'project' };
    if (changed) writeFileSync(join(root, 'input'), 'edited');
    const checking = buildSourceCheck(evidence, root, storage, owner)();
    if (changed) await expect(checking).rejects.toThrow('inputs changed before setup');
    else await expect(checking).resolves.toBeUndefined();
    expect(storage.admitInTurn).toHaveBeenCalledWith(undefined, owner);
    expect(lease.dispose).toHaveBeenCalledOnce();
    expect(lease.run).not.toHaveBeenCalled();
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe('checkout build commit', () => {
  it('records a verified HEAD and invokes git with the clone path', async () => {
    const git = vi.fn(async () => ({ stdout: 'abcdef0123456789\n' }));
    await expect(checkoutBuildCommit(git, '/clone')).resolves.toBe('abcdef0123456789');
    expect(git).toHaveBeenCalledWith(['-C', '/clone', 'rev-parse', '--verify', 'HEAD']);
  });

  it.each(['HEAD', '', 'secret-looking-text'])('leaves unusual HEAD %j unknown', async (stdout) => {
    await expect(checkoutBuildCommit(async () => ({ stdout }), '/clone')).resolves.toBeNull();
  });

  it('leaves unavailable Git provenance unknown', async () => {
    await expect(
      checkoutBuildCommit(async () => {
        throw new Error('unavailable');
      }, '/clone'),
    ).resolves.toBeNull();
  });
});
