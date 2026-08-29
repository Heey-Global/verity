import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import type { GitRunner } from './provisioner.js';
import { signHistoryForPush } from './sign-history.js';

const execFileAsync = promisify(execFile);

const git: GitRunner = async (args, opts) =>
  execFileAsync(
    'git',
    [...args],
    opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } },
  );

const COMMITTER = { name: 'Fleet', email: 'fleet@example.com' };

/** Every temp directory this file creates, removed after each test. These hold
 *  real ed25519 private keys — short-lived and test-only, but leaving them
 *  behind means a machine that has run the suite a few times is littered with
 *  usable signing keys. */
const scratchDirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A repo with a real signing key, and the history shape a local Verity project
 *  actually has: unsigned automation commits interleaved with the operator's own
 *  work, and a merge among them. */
function repoWithLocalHistory(prefix: string): {
  repo: string;
  privateKey: string;
  publicKey: string;
  run: (...args: string[]) => string;
} {
  const repo = scratchDir(prefix);
  const run = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  // Its own temp dir: a fixed path would collide across tests, and `ssh-keygen`
  // refuses to overwrite an existing key rather than regenerate it.
  const keyPath = join(scratchDir(`${prefix}key-`), 'signing_key');
  execFileSync('ssh-keygen', [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    COMMITTER.email,
    '-f',
    keyPath,
  ]);

  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Verity');
  run('config', 'user.email', 'verity@localhost');
  run('config', 'commit.gpgsign', 'false');
  run('commit', '-q', '--allow-empty', '-m', 'chore: initialize project');

  writeFileSync(join(repo, 'work.txt'), 'the operator\n');
  run('add', '.');
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=h-teske',
      '-c',
      'user.email=h@example.com',
      'commit',
      '-qm',
      'operator work',
    ],
    { encoding: 'utf8' },
  );

  // A side branch merged back, so the rebuild has to cope with two parents.
  run('checkout', '-q', '-b', 'chore/side');
  writeFileSync(join(repo, 'side.txt'), 'side\n');
  run('add', '.');
  run('commit', '-qm', 'side work');
  run('checkout', '-q', 'main');
  run('merge', '-q', '--no-ff', '--no-edit', 'chore/side');

  return {
    repo,
    privateKey: readFileSync(keyPath, 'utf8'),
    publicKey: readFileSync(`${keyPath}.pub`, 'utf8'),
    run,
  };
}

/** Teach the repo to verify the fleet key, so `%G?` is git's own verdict rather
 *  than our reading of the object header. */
function trustKey(repo: string, publicKey: string, email: string): void {
  const allowed = join(repo, '.git', 'allowed_signers');
  writeFileSync(allowed, `${email} ${publicKey}`);
  execFileSync('git', ['-C', repo, 'config', 'gpg.ssh.allowedSignersFile', allowed]);
  execFileSync('git', ['-C', repo, 'config', 'gpg.format', 'ssh']);
}

describe('signHistoryForPush', () => {
  it('(integration, real git + ssh key) signs a local history so GitHub can verify it', async () => {
    // The incident: linking a local project to a repo whose ruleset requires
    // verified signatures was rejected with "Commits must have verified
    // signatures", naming exactly the commits Verity had written itself. No
    // retry could satisfy it — the flow kept producing the same unsigned merge.
    const { repo, privateKey, publicKey, run } = repoWithLocalHistory('verity-sign-history-');
    const before = run('log', '--format=%H %an <%ae> %s').split('\n');
    // Captured BEFORE the rewrite — comparing the result against itself would
    // assert nothing at all.
    const treesBefore = run('log', '--format=%T');
    const datesBefore = run('log', '--format=%ad %cd', '--date=raw');
    expect(run('log', '--format=%H').split('\n')).toHaveLength(4);

    const rewritten = await signHistoryForPush(git, repo, {
      privateKey,
      committerName: COMMITTER.name,
      committerEmail: COMMITTER.email,
    });
    expect(rewritten).toBe(4);

    trustKey(repo, publicKey, COMMITTER.email);
    // git's own verdict: every commit signed by a key it trusts.
    expect(new Set(run('log', '--format=%G?').split('\n'))).toEqual(new Set(['G']));
    // The committer is what decides verifiability on GitHub, so it must have moved.
    expect(new Set(run('log', '--format=%cn <%ce>').split('\n'))).toEqual(
      new Set([`${COMMITTER.name} <${COMMITTER.email}>`]),
    );
    // The author must NOT have: a repair may not reattribute the operator's work.
    expect(run('log', '--format=%an <%ae> %s')).toBe(
      before.map((line) => line.split(' ').slice(1).join(' ')).join('\n'),
    );
    // Content and shape are untouched — same trees, same merge, same dates.
    expect(run('log', '--format=%T')).toBe(treesBefore);
    expect(run('log', '--format=%ad %cd', '--date=raw')).toBe(datesBefore);
    expect(run('rev-list', '--merges', '--count', 'HEAD')).toBe('1');
    expect(run('status', '--short')).toBe('');
  });

  it('(integration, real git + ssh key) is idempotent, so a retried link is a no-op', async () => {
    const { repo, privateKey, run } = repoWithLocalHistory('verity-sign-idem-');
    const identity = {
      privateKey,
      committerName: COMMITTER.name,
      committerEmail: COMMITTER.email,
    };
    await signHistoryForPush(git, repo, identity);
    const head = run('rev-parse', 'HEAD');

    // A second connect attempt must not rewrite the history it already signed —
    // otherwise every retry would produce a fresh set of object ids and the
    // import-branch dedupe would litter the repository with copies.
    expect(await signHistoryForPush(git, repo, identity)).toBe(0);
    expect(run('rev-parse', 'HEAD')).toBe(head);
  });

  it('(integration, real git + ssh key) leaves an already-verifiable prefix at its original ids', async () => {
    // A signature covers the parent ids, so rebuilding one commit invalidates
    // every descendant's — but only descendants. Commits that are already fine
    // keep their object ids, and with them any reference that names them.
    const { repo, privateKey, run } = repoWithLocalHistory('verity-sign-prefix-');
    const identity = {
      privateKey,
      committerName: COMMITTER.name,
      committerEmail: COMMITTER.email,
    };
    await signHistoryForPush(git, repo, identity);
    const root = run('rev-list', '--max-parents=0', 'HEAD');

    // One new unsigned commit on top, exactly as a session merge would leave it.
    writeFileSync(join(repo, 'later.txt'), 'later\n');
    run('add', '.');
    run('commit', '-qm', 'chore: ignore Verity session worktrees');

    expect(await signHistoryForPush(git, repo, identity)).toBe(1);
    expect(run('rev-list', '--max-parents=0', 'HEAD')).toBe(root);
  });

  it('(integration, real git + ssh key) never rewrites the history the remote already published', async () => {
    // The link flow merges the target repository's default branch in before it
    // pushes, so HEAD reaches commits this project did not write. They are
    // unsigned and committed by someone else — the same test the local commits
    // fail — but rewriting them would give the import branch an ancestry the
    // remote branch does not share, and the pull request would read as a
    // republication of the whole repository under Verity's committer.
    const { repo, privateKey, publicKey, run } = repoWithLocalHistory('verity-sign-published-');
    const remote = scratchDir('verity-sign-remote-');
    const remoteRun = (...args: string[]) =>
      execFileSync('git', ['-C', remote, ...args], { encoding: 'utf8' }).trim();
    remoteRun('init', '-q', '-b', 'main');
    remoteRun('config', 'user.name', 'Someone Else');
    remoteRun('config', 'user.email', 'someone@example.com');
    remoteRun('config', 'commit.gpgsign', 'false');
    writeFileSync(join(remote, 'README.md'), '# published\n');
    remoteRun('add', '.');
    remoteRun('commit', '-qm', 'docs: readme');
    const published = remoteRun('rev-list', 'HEAD').split('\n');

    run('remote', 'add', 'origin', remote);
    run('fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    run(
      '-c',
      'user.name=Verity',
      '-c',
      'user.email=verity@localhost',
      '-c',
      'commit.gpgsign=false',
      'merge',
      '-q',
      '--allow-unrelated-histories',
      '--no-edit',
      '-X',
      'ours',
      'refs/remotes/origin/main',
    );
    const remoteHead = run('rev-parse', 'refs/remotes/origin/main');

    // 4 local commits + the merge; the published commit is excluded.
    expect(
      await signHistoryForPush(
        git,
        repo,
        { privateKey, committerName: COMMITTER.name, committerEmail: COMMITTER.email },
        { publishedRef: 'refs/remotes/origin/main' },
      ),
    ).toBe(5);

    // Object ids intact, and still an ancestor — that is what lets the import
    // branch merge back into the branch it was forked from.
    for (const sha of published) {
      expect(run('cat-file', '-t', sha)).toBe('commit');
      expect(run('merge-base', '--is-ancestor', sha, 'HEAD') === '').toBe(true);
    }
    expect(run('rev-parse', 'HEAD^2')).toBe(remoteHead);
    expect(run('log', '--format=%cn <%ce>', published[0]!, '-1')).toBe(
      'Someone Else <someone@example.com>',
    );

    trustKey(repo, publicKey, COMMITTER.email);
    // Everything Verity wrote is verifiable; the published commit is left as the
    // remote has it, which is the only state that keeps the ancestry shared.
    expect(new Set(run('log', '--format=%G?', 'HEAD', '--not', published[0]!).split('\n'))).toEqual(
      new Set(['G']),
    );
  });

  it('(integration, real git) carries over headers it has no opinion about, minus a stale mergetag', async () => {
    // A rebuild that emits only the headers this module knows about would drop
    // the rest: `encoding` decides how the message is read. A commit that loses
    // it is a different commit. `mergetag` is the exception — it embeds the
    // signed tag the merge consumed, naming the merged commit by id, so once
    // that commit is rebuilt the header names an object that is not a parent and
    // does not exist on the remote at all.
    const { repo, privateKey, publicKey, run } = repoWithLocalHistory('verity-sign-headers-');
    const keyFile = join(repo, '.git', 'sign_key');
    writeFileSync(keyFile, privateKey, { mode: 0o600 });
    writeFileSync(`${keyFile}.pub`, publicKey);

    run('checkout', '-q', '-b', 'chore/tagged');
    writeFileSync(join(repo, 'tagged.txt'), 'tagged\n');
    run('add', '.');
    // ASCII message, non-UTF-8 declared encoding: the header has to survive even
    // though nothing else in the commit depends on it.
    run('-c', 'i18n.commitEncoding=ISO-8859-1', 'commit', '-qm', 'chore: tagged work');
    run(
      '-c',
      'gpg.format=ssh',
      '-c',
      'gpg.ssh.program=ssh-keygen',
      '-c',
      `user.signingkey=${keyFile}`,
      'tag',
      '-s',
      '-m',
      'v1',
      'v1',
    );
    run('checkout', '-q', 'main');
    run('merge', '-q', '--no-ff', '--no-edit', 'v1');

    const headersOf = (rev: string): string[] =>
      execFileSync('git', ['-C', repo, 'cat-file', 'commit', rev], { encoding: 'utf8' })
        .split('\n\n')[0]!
        .split('\n')
        .filter((line) => !line.startsWith(' '))
        .map((line) => line.split(' ')[0]!);
    expect(headersOf('HEAD')).toContain('mergetag');
    expect(headersOf('HEAD^2')).toContain('encoding');

    await signHistoryForPush(git, repo, {
      privateKey,
      committerName: COMMITTER.name,
      committerEmail: COMMITTER.email,
    });

    // The tagged commit was rebuilt, so its embedded tag went stale and the
    // header is gone rather than pointing at an object that is no longer there.
    expect(headersOf('HEAD')).not.toContain('mergetag');
    // The message is the commit's own content and stays untouched — only the
    // header that names a rebuilt object by id is gone.
    expect(run('log', '--format=%s', '-1')).toBe("Merge tag 'v1'");
    expect(headersOf('HEAD^2')).toContain('encoding');
    expect(run('fsck', '--strict', '--no-progress')).toBe('');
    trustKey(repo, publicKey, COMMITTER.email);
    expect(new Set(run('log', '--format=%G?').split('\n'))).toEqual(new Set(['G']));
  });

  it('(integration, real git + ssh key) keeps a mergetag whose target it never rebuilt', async () => {
    // The counterpart: dropping every mergetag would lose a header the commit is
    // entitled to keep. When the tagged commit stays at its original id — it was
    // already verifiable — the embedded tag still names a real parent, so it has
    // to survive the rebuild of the merge above it.
    const repo = scratchDir('verity-sign-mergetag-live-');
    const run = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const keyDir = scratchDir('verity-sign-mergetag-live-key-');
    const keyFile = join(keyDir, 'signing_key');
    execFileSync('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      COMMITTER.email,
      '-f',
      keyFile,
    ]);
    const privateKey = readFileSync(keyFile, 'utf8');
    const publicKey = readFileSync(`${keyFile}.pub`, 'utf8');

    // `gpg.ssh.program` is pinned back to git's default: a Verity sandbox points
    // it at the signing broker, which signs with the fleet key and ignores
    // `user.signingkey` entirely — the prefix would then be signed by a key this
    // test never generated, and nothing below would be "already verifiable".
    const signed = (...args: string[]) =>
      run(
        '-c',
        `user.name=${COMMITTER.name}`,
        '-c',
        `user.email=${COMMITTER.email}`,
        '-c',
        'gpg.format=ssh',
        '-c',
        'gpg.ssh.program=ssh-keygen',
        '-c',
        `user.signingkey=${keyFile}`,
        '-c',
        'commit.gpgsign=true',
        ...args,
      );
    run('init', '-q', '-b', 'main');
    // Identity at repository level, because a CI runner has none globally and
    // `git tag` refuses to guess one.
    run('config', 'user.name', 'Verity');
    run('config', 'user.email', 'verity@localhost');
    run('config', 'commit.gpgsign', 'false');
    // Everything below the merge is already exactly what this module would
    // produce — our key, our committer — so the rewrite starts at the merge.
    signed('commit', '-q', '--allow-empty', '-m', 'chore: initialize project');
    run('checkout', '-q', '-b', 'chore/tagged');
    writeFileSync(join(repo, 'tagged.txt'), 'tagged\n');
    run('add', '.');
    signed('commit', '-qm', 'chore: tagged work');
    const tagged = run('rev-parse', 'HEAD');
    run(
      '-c',
      'gpg.format=ssh',
      '-c',
      'gpg.ssh.program=ssh-keygen',
      '-c',
      `user.signingkey=${keyFile}`,
      'tag',
      '-s',
      '-m',
      'v1',
      'v1',
    );
    run('checkout', '-q', 'main');
    // Unsigned and under Verity's own identity, as every merge it writes is today.
    run(
      '-c',
      'user.name=Verity',
      '-c',
      'user.email=verity@localhost',
      'merge',
      '-q',
      '--no-ff',
      '--no-edit',
      'v1',
    );

    expect(
      await signHistoryForPush(git, repo, {
        privateKey,
        committerName: COMMITTER.name,
        committerEmail: COMMITTER.email,
      }),
    ).toBe(1);

    expect(run('rev-parse', 'HEAD^2')).toBe(tagged);
    expect(run('cat-file', 'commit', 'HEAD')).toContain(`mergetag object ${tagged}`);
    expect(run('fsck', '--strict', '--no-progress')).toBe('');
    trustKey(repo, publicKey, COMMITTER.email);
    expect(new Set(run('log', '--format=%G?').split('\n'))).toEqual(new Set(['G']));
  });

  it('(integration, real git + ssh key) re-signs a commit signed by a key that is not ours', async () => {
    // The presence of a `gpgsig` header proves nothing about whether GitHub will
    // accept it: a signature by a key the account never registered, under the
    // fleet's own committer email, is indistinguishable at the header level and
    // would be skipped straight into the same rejected push.
    const { repo, privateKey, publicKey, run } = repoWithLocalHistory('verity-sign-foreign-');
    const identity = {
      privateKey,
      committerName: COMMITTER.name,
      committerEmail: COMMITTER.email,
    };
    // It has to sit on top of a history that is ALREADY fine, or the commits
    // under it would drag it into the rewrite regardless of its signature and
    // the test would pass without the check it exists for.
    await signHistoryForPush(git, repo, identity);

    const strangerDir = scratchDir('verity-sign-stranger-');
    const strangerKey = join(strangerDir, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'x', '-f', strangerKey]);

    writeFileSync(join(repo, 'stranger.txt'), 'stranger\n');
    run('add', '.');
    run(
      '-c',
      'gpg.format=ssh',
      // Without this the Verity sandbox would hand the signing to the broker,
      // and the commit would carry the container's fleet key rather than the
      // stranger's — a different test than the one this is.
      '-c',
      'gpg.ssh.program=ssh-keygen',
      '-c',
      `user.signingkey=${strangerKey}`,
      '-c',
      `user.name=${COMMITTER.name}`,
      '-c',
      `user.email=${COMMITTER.email}`,
      'commit',
      '-qS',
      '-m',
      'chore: signed by a stranger',
    );
    const foreign = run('rev-parse', 'HEAD');

    // Exactly that one commit: the fleet-signed prefix under it stays put.
    expect(await signHistoryForPush(git, repo, identity)).toBe(1);
    expect(run('rev-parse', 'HEAD')).not.toBe(foreign);
    expect(run('rev-parse', 'HEAD~1')).toBe(run('rev-parse', `${foreign}~1`));

    // git's own verdict, against the fleet key alone — the trust set GitHub
    // works from once the fleet identity is the committer.
    trustKey(repo, publicKey, COMMITTER.email);
    expect(new Set(run('log', '--format=%G?').split('\n'))).toEqual(new Set(['G']));
  });

  it('(integration, real git) refuses an identity that would inject a commit header', async () => {
    // `gitUserName`/`gitUserEmail` come from project settings, which validate a
    // length and nothing more. Assembling the commit object by hand means a
    // newline in either one ends the header and starts another, so a crafted
    // name could graft a parent onto a commit this module then signs — a forged
    // ancestry carrying a valid fleet signature. Refuse before reading anything.
    const { repo, privateKey, run } = repoWithLocalHistory('verity-sign-inject-');
    const head = run('rev-parse', 'HEAD');
    const forgedParent = run('rev-list', '--max-parents=0', 'HEAD');

    for (const identity of [
      {
        privateKey,
        committerName: `Fleet\nparent ${forgedParent}`,
        committerEmail: COMMITTER.email,
      },
      { privateKey, committerName: COMMITTER.name, committerEmail: 'fleet@example.com> <evil' },
    ]) {
      await expect(signHistoryForPush(git, repo, identity)).rejects.toThrow(
        /commit header cannot carry/u,
      );
    }
    // Refusing has to leave the history exactly as it was: the link is
    // best-effort, and a half-rewritten history would be worse than none.
    expect(run('rev-parse', 'HEAD')).toBe(head);
    expect(run('status', '--short')).toBe('');
  });
});
