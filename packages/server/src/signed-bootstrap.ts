import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_SIGN_NAMESPACE, signGitPayload } from './git-signer.js';
import type { GitRunner } from './provisioner.js';
import type { HistorySigningIdentity } from './sign-history.js';

/** Create the first commit with the configured server signer, without rewriting any history. */
export async function createSignedEmptyCommit(
  git: GitRunner,
  repo: string,
  identity: HistorySigningIdentity,
): Promise<void> {
  for (const value of [identity.committerName, identity.committerEmail]) {
    if (!value.trim() || /[\r\n<>\0]/u.test(value)) throw new Error('Invalid Git signing identity');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'verity-bootstrap-'));
  try {
    const empty = join(scratch, 'empty');
    writeFileSync(empty, '');
    const tree = (await git(['-C', repo, 'hash-object', '-w', '-t', 'tree', empty])).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Error('Invalid empty tree');
    const person = `${identity.committerName} <${identity.committerEmail}> ${Math.floor(Date.now() / 1000)} +0000`;
    const headers = `tree ${tree}\nauthor ${person}\ncommitter ${person}`;
    const message = 'chore: initialize project\n';
    const signature = await signGitPayload(
      identity.privateKey,
      Buffer.from(`${headers}\n\n${message}`),
      GIT_SIGN_NAMESPACE,
    );
    const object = join(scratch, 'commit');
    const folded = signature.trimEnd().split('\n').join('\n ');
    writeFileSync(object, `${headers}\ngpgsig ${folded}\n\n${message}`);
    const sha = (
      await git(['-C', repo, 'hash-object', '-w', '-t', 'commit', object])
    ).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) throw new Error('Invalid bootstrap commit');
    // Compare-and-swap: a concurrent first writer must never have its commit replaced.
    await git(['-C', repo, 'update-ref', 'HEAD', sha, '0'.repeat(sha.length)]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
