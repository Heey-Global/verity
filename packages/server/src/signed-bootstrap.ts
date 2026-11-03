import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_SIGN_NAMESPACE, signGitPayload, type SshSignSpawner } from './git-signer.js';
import type { GitRunner } from './provisioner.js';
import type { HistorySigningIdentity } from './sign-history.js';

/** Create the first commit with the configured server signer, without rewriting any history. */
export async function createSignedEmptyCommit(
  git: GitRunner,
  repo: string,
  identity: HistorySigningIdentity,
  spawn?: SshSignSpawner,
): Promise<void> {
  return createSignedCommit(git, repo, identity, undefined, spawn);
}

/** Complete a pending merge with a new signed commit; existing commits keep their IDs. */
export async function createSignedMergeCommit(
  git: GitRunner,
  repo: string,
  identity: HistorySigningIdentity,
  spawn?: SshSignSpawner,
): Promise<void> {
  const head = (await git(['-C', repo, 'rev-parse', '--verify', 'HEAD'])).stdout.trim();
  const other = (await git(['-C', repo, 'rev-parse', '--verify', 'MERGE_HEAD'])).stdout.trim();
  const tree = (await git(['-C', repo, 'write-tree'])).stdout.trim();
  await createSignedCommit(git, repo, identity, { tree, parents: [head, other] }, spawn);
  await git(['-C', repo, '-c', 'core.hooksPath=/dev/null', 'merge', '--quit']);
}

async function createSignedCommit(
  git: GitRunner,
  repo: string,
  identity: HistorySigningIdentity,
  merge?: { tree: string; parents: string[] },
  spawn?: SshSignSpawner,
): Promise<void> {
  for (const value of [identity.committerName, identity.committerEmail]) {
    if (!value.trim() || /[\r\n<>\0]/u.test(value)) throw new Error('Invalid Git signing identity');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'verity-bootstrap-'));
  try {
    const empty = join(scratch, 'empty');
    writeFileSync(empty, '');
    const tree =
      merge?.tree ??
      (await git(['-C', repo, 'hash-object', '-w', '-t', 'tree', empty])).stdout.trim();
    const parents = merge?.parents ?? [];
    for (const parent of parents)
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(parent)) throw new Error('Invalid merge parent');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Error('Invalid empty tree');
    const person = `${identity.committerName} <${identity.committerEmail}> ${Math.floor(Date.now() / 1000)} +0000`;
    const headers = [
      `tree ${tree}`,
      ...parents.map((parent) => `parent ${parent}`),
      `author ${person}`,
      `committer ${person}`,
    ].join('\n');
    const message = merge ? 'chore: merge destination history\n' : 'chore: initialize project\n';
    const signature = await signGitPayload(
      identity.privateKey,
      Buffer.from(`${headers}\n\n${message}`),
      GIT_SIGN_NAMESPACE,
      spawn,
    );
    const object = join(scratch, 'commit');
    const folded = signature.trimEnd().split('\n').join('\n ');
    writeFileSync(object, `${headers}\ngpgsig ${folded}\n\n${message}`);
    const sha = (
      await git(['-C', repo, 'hash-object', '-w', '-t', 'commit', object])
    ).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) throw new Error('Invalid bootstrap commit');
    // Compare-and-swap protects both an unborn HEAD and a pending merge parent.
    await git([
      '-C',
      repo,
      '-c',
      'core.hooksPath=/dev/null',
      'update-ref',
      'HEAD',
      sha,
      parents[0] ?? '0'.repeat(sha.length),
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
