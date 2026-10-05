import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSessionCloneProvisioner } from './session-clone.js';
import { createGitBranchService, type GitOutput } from './branches.js';
import { transferSessionCommit } from './session-git-transfer.js';

let temp: string | undefined;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const scopedGit =
  (root: string): GitOutput =>
  (args) =>
    Promise.resolve().then(() => {
      if (args[0] !== '-C' || args[1] !== root)
        throw new Error('Sandbox cannot access another checkout');
      return execFileSync('git', [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    });

it('merges independent clones by explicit bundles without granting either sandbox foreign paths', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-'));
  const base = join(temp, 'base');
  mkdirSync(base);
  git(base, 'init', '-b', 'main');
  git(base, 'config', 'user.name', 'Test');
  git(base, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(base, 'original'), 'base\n');
  git(base, 'add', '.');
  git(base, 'commit', '-m', 'initial');
  const session = await createSessionCloneProvisioner({
    repoDir: base,
    worktreeRoot: join(temp, 'sessions'),
    baseBranch: 'main',
  }).add('agent/change');
  git(session, 'config', 'user.name', 'Test');
  git(session, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(session, 'change'), 'session\n');
  git(session, 'add', '.');
  git(session, 'commit', '-m', 'change');
  const sessionTip = git(session, 'rev-parse', 'HEAD');
  const centralGit = scopedGit(base);
  const sessionGit = scopedGit(session);
  const branches = createGitBranchService({ git: sessionGit });
  const imported = await transferSessionCommit({
    source: session,
    destination: base,
    sourceGit: sessionGit,
    destinationGit: centralGit,
  });
  const merged = await branches.mergeIntoLocalBase(session, base, {
    git: centralGit,
    sessionGit,
    mergeRef: imported.ref,
  });
  await imported.cleanup();
  expect(merged.mergedTip).toBe(sessionTip);
  expect(git(base, 'branch', '--list', 'agent/change')).toBe('');
  expect(git(base, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
  const reverse = await transferSessionCommit({
    source: base,
    destination: session,
    sourceGit: centralGit,
    destinationGit: sessionGit,
    commit: merged.baseTip,
  });
  const reset = await branches.resetToLocalBase(session, 'main', merged, { git: sessionGit });
  await reverse.cleanup();
  expect(reset.deletedBranch).toBe('agent/change');
  expect(git(session, 'rev-parse', 'HEAD')).toBe(merged.baseTip);
  expect(git(base, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
  expect(git(session, 'for-each-ref', '--format=%(refname)', 'refs/verity')).toBe('');
});

it('never writes through a destination directory replaced by an agent symlink', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-race-'));
  const source = join(temp, 'source');
  const destination = join(temp, 'destination');
  const outside = join(temp, 'outside');
  for (const dir of [source, destination, outside]) mkdirSync(dir);
  const sourceGit: GitOutput = async (args) => {
    if (args.includes('rev-parse')) return 'a'.repeat(40);
    if (args.includes('create')) {
      const transfer = readdirSync(destination).find((entry) =>
        entry.startsWith('.verity-transfer-'),
      )!;
      renameSync(join(destination, transfer), join(destination, 'displaced'));
      symlinkSync(outside, join(destination, transfer));
      writeFileSync(join(source, args[args.indexOf('create') + 1]!), 'bundle');
    }
    return '';
  };
  await expect(
    transferSessionCommit({
      source,
      destination,
      sourceGit,
      destinationGit: async () => '',
    }),
  ).rejects.toThrow('Session Git transfer failed');
  // A trusted host write must not follow a directory the agent substituted.
  expect(existsSync(join(outside, 'commit.bundle'))).toBe(false);
});

it('does not redirect cleanup when the checkout ancestor is replaced', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-cleanup-'));
  const source = join(temp, 'source');
  const destination = join(temp, 'destination');
  const outside = join(temp, 'outside');
  for (const dir of [source, destination, outside]) mkdirSync(dir);
  const transfer = await transferSessionCommit({
    source,
    destination,
    sourceGit: async (args) => {
      if (args.includes('rev-parse')) return 'a'.repeat(40);
      if (args.includes('create'))
        writeFileSync(join(source, args[args.indexOf('create') + 1]!), 'bundle');
      return '';
    },
    destinationGit: async () => '',
  });
  const name = readdirSync(destination).find((entry) => entry.startsWith('.verity-transfer-'))!;
  mkdirSync(join(outside, name));
  writeFileSync(join(outside, name, 'keep'), 'unrelated host data');
  renameSync(destination, join(temp, 'displaced'));
  symlinkSync(outside, destination);
  await transfer.cleanup();
  expect(existsSync(join(outside, name, 'keep'))).toBe(true);
  expect(existsSync(join(temp, 'displaced', name))).toBe(false);
});

it('rejects substituted FIFOs without blocking the server while waiting for a writer', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-fifo-'));
  const source = join(temp, 'source');
  const destination = join(temp, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  let writer: ReturnType<typeof spawn> | undefined;
  let openedAt = 0;
  try {
    await expect(
      transferSessionCommit({
        source,
        destination,
        sourceGit: async (args) => {
          if (args.includes('rev-parse')) return 'a'.repeat(40);
          if (args.includes('create')) {
            const bundle = join(source, args[args.indexOf('create') + 1]!);
            rmSync(bundle);
            execFileSync('mkfifo', [bundle]);
            // Release a regressed blocking open so the test fails without hanging the worker.
            writer = spawn('sh', ['-c', 'sleep 2; printf x > "$1"', 'fifo-writer', bundle]);
            openedAt = Date.now();
          }
          return '';
        },
        destinationGit: async () => '',
      }),
    ).rejects.toThrow('Session Git transfer failed');
    expect(Date.now() - openedAt).toBeLessThan(1000);
  } finally {
    writer?.kill();
  }
});

it('grants sandbox users access to transfer files without requiring the server UID', async () => {
  temp = mkdtempSync(join(tmpdir(), 'verity-transfer-permissions-'));
  const source = join(temp, 'source');
  const destination = join(temp, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  let modes: number[] = [];
  const transfer = await transferSessionCommit({
    source,
    destination,
    sourceGit: async (args) => {
      if (args.includes('rev-parse')) return 'a'.repeat(40);
      if (args.includes('create')) {
        const bundle = join(source, args[args.indexOf('create') + 1]!);
        const target = readdirSync(destination).find((entry) =>
          entry.startsWith('.verity-transfer-'),
        )!;
        modes = [
          statSync(join(bundle, '..')).mode & 0o777,
          statSync(bundle).mode & 0o666,
          statSync(join(destination, target)).mode & 0o555,
          statSync(join(destination, target, 'commit.bundle')).mode & 0o444,
        ];
        writeFileSync(bundle, 'bundle');
      }
      return '';
    },
    destinationGit: async () => '',
  });
  try {
    expect(modes).toEqual([0o777, 0o666, 0o555, 0o444]);
  } finally {
    await transfer.cleanup();
  }
});
