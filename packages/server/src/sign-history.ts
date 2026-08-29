import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GIT_SIGN_NAMESPACE, signGitPayload, type SshSignSpawner } from './git-signer.js';
import type { GitRunner } from './provisioner.js';

/**
 * Sign a local project's history at the moment it stops being local.
 *
 * A project Verity created has never been pushed anywhere, and Verity signs none
 * of the commits it writes itself: `chore: initialize project`, the session
 * merges, the merge that pulls an existing GitHub history in. That is invisible
 * until the operator connects the project to a repository whose ruleset requires
 * verified signatures — at which point the push is rejected outright, and no
 * retry can satisfy it, because the flow keeps producing the same unsigned
 * commits.
 *
 * Connect is the one moment where this can be repaired for free: the history has
 * never been published, so rewriting it breaks nobody's clone. Afterwards the
 * repository is shared and the same rewrite would be unthinkable.
 *
 * Two things have to be true for GitHub to call a commit verified, and Verity's
 * commits fail both:
 *
 * - it carries an SSH signature made by the fleet key, and
 * - its COMMITTER email is a verified address on the account that key belongs to.
 *   Verity commits as `verity@localhost`, which no account can verify — so a
 *   signature alone would still be rejected. The rebuild therefore re-commits
 *   with the fleet identity as committer while keeping the ORIGINAL author line
 *   byte for byte, the same split GitHub itself uses for commits made in its web
 *   UI.
 *
 * The commit object is assembled here and handed to {@link signGitPayload} — the
 * server's existing signing primitive — rather than signed through `git
 * commit-tree -S`. Going through git would mean signing via whatever
 * `gpg.ssh.program` is configured, and that wrapper exists to keep the private
 * key OUT of a sandbox by forwarding to the broker: it ignores `user.signingkey`
 * and, with no broker token bound, refuses outright. Assembling the object keeps
 * this on the one server-side path that is allowed to hold the key at all.
 */
export interface HistorySigningIdentity {
  /** Fleet signing private key, PEM. Never written to disk by this module —
   *  {@link signGitPayload} owns that, including wiping it afterwards. */
  privateKey: string;
  /** Committer name to re-commit under. */
  committerName: string;
  /** Committer email — must be verified on the key's GitHub account. */
  committerEmail: string;
}

export interface SignHistoryOptions {
  /**
   * A ref whose ancestry is already published and must keep its object ids.
   *
   * The link flow merges an existing GitHub repository's default branch into the
   * local history before pushing, so `HEAD` then reaches commits this project
   * never wrote. Those are the one part of the graph a rewrite may not touch:
   * new ids there would share no ancestry with the remote branch, and the
   * import pull request would read as a wholesale republication of the
   * repository under a new committer.
   */
  publishedRef?: string;
  /** Test seam handed straight to {@link signGitPayload}. */
  spawn?: SshSignSpawner;
}

/**
 * Characters no git identity may contain, because the commit object has no way
 * to escape them: a newline ends the header and starts another one, and the
 * angle brackets delimit the email. `gitUserName`/`gitUserEmail` arrive from
 * project settings, which validate a length and nothing else, so a name
 * carrying `\nparent <sha>` would graft an ancestor onto a commit this module
 * then signs — a forged, verified-looking history. git itself refuses these in
 * `user.name`/`user.email`; assembling the object by hand means refusing them
 * here.
 */
const FORBIDDEN_IN_IDENTITY = /[\n\r<>]/u;

/** One header of a commit object, kept verbatim so a rebuild can reproduce the
 *  ones this module has no opinion about. */
interface CommitHeader {
  /** Header name (`tree`, `parent`, `author`, `encoding`, `mergetag`, …). */
  name: string;
  /** The header exactly as stored, continuation lines included. */
  raw: string;
}

/** One commit, as `git cat-file commit` hands it over. */
interface RawCommit {
  sha: string;
  /** Every header in its original order — see {@link rebuiltObject} for why the
   *  ones this module does not replace are carried over untouched. */
  headers: CommitHeader[];
  parents: string[];
  /** The committer's `<unix> <tz>` suffix; the identity in front of it is replaced. */
  committerDate: string;
  committerEmail: string;
  message: string;
}

/**
 * The signing key an SSH signature was made with, as `type base64` — the same
 * text form an `allowed_signers` line carries.
 *
 * A commit is left alone only when THIS key signed it, so the check has to read
 * the key out of the signature rather than trust the mere presence of a `gpgsig`
 * header: a signature made by a key GitHub does not know, or a malformed one,
 * looks identical at the header level and would be skipped straight into the
 * same rejected push. The signature's own key is the only thing that can be
 * compared here without asking GitHub which keys it trusts.
 *
 * `SSHSIG` (PROTOCOL.sshsig): the 6-byte magic, a `uint32` version, then the
 * public key as a length-prefixed string. Returns `undefined` for anything that
 * is not a well-formed SSH signature — a GPG signature, a truncated one — which
 * the caller reads as "not ours", the safe direction.
 */
function signingKeyOf(armored: string): string | undefined {
  const body = armored
    .split('\n')
    .map((line) => line.replace(/^ /u, '').trim())
    .filter((line) => line !== '' && !line.startsWith('-----'))
    .join('');
  let blob: Buffer;
  try {
    blob = Buffer.from(body, 'base64');
  } catch {
    return undefined;
  }
  if (blob.subarray(0, 6).toString('latin1') !== 'SSHSIG') return undefined;
  const start = 6 + 4;
  if (blob.length < start + 4) return undefined;
  const length = blob.readUInt32BE(start);
  const key = blob.subarray(start + 4, start + 4 + length);
  if (key.length !== length || length === 0) return undefined;
  // The key blob starts with its own length-prefixed type name, which is what
  // the text form repeats in front of the base64.
  if (key.length < 4) return undefined;
  const typeLength = key.readUInt32BE(0);
  if (key.length < 4 + typeLength) return undefined;
  return `${key.subarray(4, 4 + typeLength).toString('utf8')} ${key.toString('base64')}`;
}

/**
 * Parse a raw commit object. The header block ends at the first empty line;
 * a header's value continues across lines whenever the next line starts with a
 * space (`gpgsig` and `mergetag` both do), so a naive line scan would read a
 * signature's body as further headers.
 */
function parseCommit(sha: string, raw: string): RawCommit {
  const split = raw.indexOf('\n\n');
  const header = split === -1 ? raw : raw.slice(0, split);
  const message = split === -1 ? '' : raw.slice(split + 2);
  const headers: CommitHeader[] = [];
  const parents: string[] = [];
  let committerDate = '';
  let committerEmail = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ') && headers.length > 0) {
      // Continuation of the header above — keep it attached to that entry.
      headers[headers.length - 1]!.raw += `\n${line}`;
      continue;
    }
    const name = line.slice(0, line.indexOf(' ') === -1 ? line.length : line.indexOf(' '));
    headers.push({ name, raw: line });
    if (name === 'parent') parents.push(line.slice('parent '.length));
    else if (name === 'committer') {
      const value = line.slice('committer '.length);
      const match = /^.*?<([^>]*)>\s*(.*)$/u.exec(value);
      committerEmail = match?.[1] ?? '';
      committerDate = match?.[2] ?? '';
    }
  }
  return { sha, headers, parents, committerDate, committerEmail, message };
}

/** The commit exactly as it is stored today, reassembled from the parse. Used to
 *  prove the parse is lossless before anything is written — see
 *  {@link signHistoryForPush}. */
function originalObject(commit: RawCommit): string {
  return `${commit.headers.map((entry) => entry.raw).join('\n')}\n\n${commit.message}`;
}

/**
 * The rebuilt commit object, minus the signature — this is both what gets signed
 * and, with the signature spliced back in, what gets written.
 *
 * Every header is carried over verbatim except the three this module owns:
 * `parent` (remapped onto rebuilt ancestors), `committer` (the fleet identity),
 * and `gpgsig` (replaced by the new signature). Emitting only the headers this
 * module knows about would silently drop the ones it does not — `encoding`
 * decides how the message is to be read — and a commit that loses them is a
 * different commit.
 *
 * `mergetag` is the one carried-over header that can go stale: it embeds the
 * signed tag a merge consumed, and that tag names the merged commit by id. When
 * that commit is itself rebuilt, the embedded tag would keep naming an object
 * that is no longer a parent and, after the push, does not exist in the
 * repository at all. Such a header is dropped rather than carried; a mergetag
 * whose target keeps its id is preserved.
 */
function rebuiltObject(
  commit: RawCommit,
  parents: readonly string[],
  identity: HistorySigningIdentity,
  rewritten: ReadonlyMap<string, string>,
  signature?: string,
): string {
  const lines: string[] = [];
  let parentsEmitted = false;
  for (const entry of commit.headers) {
    if (entry.name === 'gpgsig') continue;
    if (entry.name === 'mergetag') {
      const tagged = /^mergetag object ([0-9a-f]+)$/mu.exec(entry.raw.split('\n')[0] ?? '')?.[1];
      if (tagged !== undefined && rewritten.has(tagged)) continue;
    }
    if (entry.name === 'parent') {
      if (parentsEmitted) continue;
      lines.push(...parents.map((parent) => `parent ${parent}`));
      parentsEmitted = true;
      continue;
    }
    if (entry.name === 'committer') {
      lines.push(
        `committer ${identity.committerName} <${identity.committerEmail}> ${commit.committerDate}`,
      );
      continue;
    }
    lines.push(entry.raw);
  }
  if (signature !== undefined) {
    // git's own encoding: the header value's continuation lines each carry one
    // leading space, which is stripped again on read. Appended last, where git
    // itself puts extra headers.
    const armored = signature.replace(/\n$/u, '').split('\n');
    lines.push(`gpgsig ${armored[0] ?? ''}`, ...armored.slice(1).map((line) => ` ${line}`));
  }
  return `${lines.join('\n')}\n\n${commit.message}`;
}

/**
 * Rewrite every commit from the first unverifiable one onward, signing each with
 * the fleet key.
 *
 * The cut cannot be "only the unsigned ones": a signature covers the commit
 * object including its parent ids, so rebuilding one commit invalidates the
 * signature of every descendant. Once the earliest offender is found, everything
 * after it is rebuilt and re-signed — commits before it keep their object ids and
 * are never touched, as does anything reachable from
 * {@link SignHistoryOptions.publishedRef}.
 *
 * @returns the number of commits rebuilt (0 when the history was already fine).
 */
export async function signHistoryForPush(
  git: GitRunner,
  clonePath: string,
  identity: HistorySigningIdentity,
  opts: SignHistoryOptions = {},
): Promise<number> {
  // Before anything is read, let alone written: an identity that cannot be
  // expressed in a commit header is a header-injection vector, and the caller
  // treats a throw as "leave the history alone" (see FORBIDDEN_IN_IDENTITY).
  for (const [field, value] of [
    ['committer name', identity.committerName],
    ['committer email', identity.committerEmail],
  ] as const) {
    if (FORBIDDEN_IN_IDENTITY.test(value)) {
      throw new Error(`the configured ${field} contains a character a commit header cannot carry`);
    }
  }

  // Anything the remote already published is excluded outright rather than
  // merely found "good": those commits belong to other people, carry other
  // committers, and are the ancestry the import pull request has to share.
  const revList = ['-C', clonePath, 'rev-list', '--topo-order', '--reverse', 'HEAD'];
  if (opts.publishedRef !== undefined) revList.push('--not', opts.publishedRef);
  const listed = (await git(revList)).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (listed.length === 0) return 0;

  const commits: RawCommit[] = [];
  for (const sha of listed) {
    const raw = (await git(['-C', clonePath, 'cat-file', 'commit', sha])).stdout;
    commits.push(parseCommit(sha, raw));
  }

  const scratch = mkdtempSync(join(tmpdir(), 'verity-sign-history-'));
  const objectPath = join(scratch, 'commit');
  const hashObject = async (content: string, write: boolean): Promise<string> => {
    writeFileSync(objectPath, content);
    return (
      await git([
        '-C',
        clonePath,
        'hash-object',
        '-t',
        'commit',
        ...(write ? ['-w'] : []),
        objectPath,
      ])
    ).stdout.trim();
  };
  try {
    // Which key is ours, read back out of a signature made here: the private key
    // never leaves `signGitPayload`, and deriving the public half any other way
    // would mean writing it to a file this module does not own.
    const ourKey = signingKeyOf(
      await signGitPayload(
        identity.privateKey,
        Buffer.from('verity-sign-history-probe', 'utf8'),
        GIT_SIGN_NAMESPACE,
        opts.spawn,
      ),
    );
    // Then let git verify, rather than trusting the key a signature claims: a
    // tampered or truncated signature can carry the fleet key blob and still be
    // worthless, and skipping it would leave exactly the commit GitHub rejects.
    // `%G?` is `G` only when the signature checks out against a key in the
    // allowed-signers file written here, which holds exactly one key: this
    // fleet's. Anything else — a foreign key, a mangled blob, no signature —
    // comes back as some other verdict.
    const verdicts = new Map<string, string>();
    if (ourKey !== undefined) {
      const allowedSigners = join(scratch, 'allowed_signers');
      writeFileSync(allowedSigners, `${identity.committerEmail} ${ourKey}\n`);
      // Chunked: a long-lived local project's history would otherwise build an
      // argument list git has to reject.
      for (let at = 0; at < listed.length; at += 200) {
        const batch = listed.slice(at, at + 200);
        const verified = await git([
          '-C',
          clonePath,
          '-c',
          'gpg.format=ssh',
          '-c',
          `gpg.ssh.allowedSignersFile=${allowedSigners}`,
          'log',
          '--no-walk=unsorted',
          '--format=%H %G?',
          ...batch,
        ]);
        for (const line of verified.stdout.split('\n')) {
          const [sha, verdict] = line.trim().split(' ');
          if (sha !== undefined && verdict !== undefined) verdicts.set(sha, verdict);
        }
      }
    }
    // The committer email is re-checked here rather than left to `%G?` alone, so
    // the cut does not depend on which identity git matches its principal
    // against: GitHub verifies against the committer, and that is the one this
    // module can state outright.
    const firstBad = commits.findIndex(
      (commit) =>
        verdicts.get(commit.sha) !== 'G' || commit.committerEmail !== identity.committerEmail,
    );
    if (firstBad === -1) return 0;

    // old sha → new sha, so a rebuilt commit's children graft onto the rebuilt
    // parent instead of the original. Untouched ancestors are absent from the map
    // and map to themselves, which is what keeps the prefix — and the published
    // history — byte-identical.
    const rewritten = new Map<string, string>();
    for (const commit of commits.slice(firstBad)) {
      // A commit object reaches this module as text, so a message that is not
      // valid UTF-8 would come back mangled and be written as a different commit.
      // Reassembling the original and re-hashing it proves the round trip is
      // faithful before anything is written; when it is not, refusing leaves the
      // history exactly as it was and the push reports what GitHub objects to.
      if ((await hashObject(originalObject(commit), false)) !== commit.sha) {
        throw new Error(`commit ${commit.sha} cannot be rebuilt byte-for-byte; leaving it alone`);
      }
      const parents = commit.parents.map((parent) => rewritten.get(parent) ?? parent);
      const signature = await signGitPayload(
        identity.privateKey,
        Buffer.from(rebuiltObject(commit, parents, identity, rewritten), 'utf8'),
        GIT_SIGN_NAMESPACE,
        opts.spawn,
      );
      rewritten.set(
        commit.sha,
        await hashObject(rebuiltObject(commit, parents, identity, rewritten, signature), true),
      );
    }

    const head = rewritten.get(commits[commits.length - 1]!.sha);
    if (head === undefined) return 0;
    // The trees are identical to what is already checked out, so a soft reset
    // moves the branch without touching a single file in the working tree — any
    // uncommitted work survives untouched.
    await git(['-C', clonePath, 'reset', '--soft', head]);
    return commits.length - firstBad;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
