import { describe, expect, it } from 'vitest';
import { DockerError } from './docker.js';
import {
  containerGitArgs,
  createSandboxGit,
  SandboxUnavailableError,
  type SandboxExec,
} from './sandbox-git.js';

/** Records every exec and answers with a canned result, or throws one shaped like
 *  `execFile`'s rejection (a non-zero exit carrying stdout/stderr). */
function fakeExec(result: { stdout?: string; stderr?: string } | Error): {
  exec: SandboxExec;
  calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[];
} {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: SandboxExec = async (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    if (result instanceof Error) throw result;
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { exec, calls };
}

/** An `execFile` rejection: a non-zero exit with the process's own streams attached. */
function exitedNonZero(stderr: string): Error {
  return Object.assign(new Error('Command failed'), { stdout: '', stderr, code: 1 });
}

describe('containerGitArgs', () => {
  it('rewrites the paths git takes as arguments', () => {
    expect(
      containerGitArgs(
        [
          '-C',
          '/clones/acme-app/.verity-sessions/agent-1',
          '--work-tree=/clones/acme-app',
          'status',
        ],
        '/clones/acme-app',
      ),
    ).toEqual(['-C', '/work/.verity-sessions/agent-1', '--work-tree=/work', 'status']);
  });

  it('maps the clone root itself, and honours a non-default container root', () => {
    expect(containerGitArgs(['-C', '/clones/acme-app', 'log'], '/clones/acme-app')).toEqual([
      '-C',
      '/work',
      'log',
    ]);
    expect(containerGitArgs(['-C', '/clones/acme-app', 'log'], '/clones/acme-app', '/src')).toEqual(
      ['-C', '/src', 'log'],
    );
  });

  // A branch name is text the session chose. Rewriting "anything that starts with the
  // clone path" would rewrite a branch named after it too — and that name ends up in
  // `update-ref`/`checkout`, where the difference is which ref gets deleted.
  it('leaves everything that is not a path argument byte-for-byte', () => {
    expect(
      containerGitArgs(
        [
          '-C',
          '/clones/acme-app',
          '-c',
          'core.hooksPath=/dev/null',
          'update-ref',
          '-d',
          'refs/heads//clones/acme-app/x',
          '--',
          '/clones/acme-app',
        ],
        '/clones/acme-app',
      ),
    ).toEqual([
      '-C',
      '/work',
      '-c',
      'core.hooksPath=/dev/null',
      'update-ref',
      '-d',
      'refs/heads//clones/acme-app/x',
      '--',
      '/clones/acme-app',
    ]);
  });

  // Not mounted in the container, so it would resolve to a different repository or to
  // nothing at all. Neither may be silently attempted.
  it('refuses a path outside the clone', () => {
    expect(() => containerGitArgs(['-C', '/etc', 'status'], '/clones/acme-app')).toThrow(
      /not under project root/,
    );
    expect(() =>
      containerGitArgs(['--work-tree=/clones/other-app', 'status'], '/clones/acme-app'),
    ).toThrow(/not under project root/);
  });

  it('refuses a -C with no path rather than dropping it', () => {
    expect(() => containerGitArgs(['-C'], '/clones/acme-app')).toThrow(/missing its path/);
  });
});

describe('createSandboxGit', () => {
  const opts = {
    containerName: 'verity-acme--app',
    hostRoot: '/clones/acme-app',
    inspect: () => Promise.resolve({ running: true }),
  };

  it('runs git in the container with no shell between, as the container user', async () => {
    const { exec, calls } = fakeExec({ stdout: 'main\n' });
    const git = createSandboxGit({ ...opts, exec });

    expect(
      await git(['-C', '/clones/acme-app', 'symbolic-ref', '--quiet', '--short', 'HEAD']),
    ).toBe('main\n');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('docker');
    expect(calls[0]?.args).toEqual([
      'exec',
      '-w',
      '/work',
      'verity-acme--app',
      'git',
      '-C',
      '/work',
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    // A shell would re-parse every argument, which is how a branch name becomes a
    // command; `--user` would run the merge as someone other than the session, leaving
    // files the agent cannot write.
    expect(calls[0]?.args).not.toContain('-lc');
    expect(calls[0]?.args).not.toContain('--user');
  });

  it('points the CLI at the configured daemon', async () => {
    const { exec, calls } = fakeExec({ stdout: '' });
    const git = createSandboxGit({
      ...opts,
      exec,
      dockerBaseUrl: 'unix:///var/run/docker.sock:/v1.41',
    });

    await git(['-C', '/clones/acme-app', 'status']);
    expect(calls[0]?.env['DOCKER_HOST']).toBe('unix:///var/run/docker.sock');
  });

  // The merge path reads a non-zero exit as a repository fact (`merge-base
  // --is-ancestor` failing means there IS something to merge). Wrapping it would turn
  // every such probe into an unexpected failure.
  it('lets a non-zero git exit through unchanged', async () => {
    const failure = exitedNonZero('fatal: not a valid object name\n');
    const { exec } = fakeExec(failure);
    const git = createSandboxGit({ ...opts, exec });

    await expect(git(['-C', '/clones/acme-app', 'rev-parse', 'nope'])).rejects.toBe(failure);
  });

  // ... unless docker itself could not run the command: a stopped project must not be
  // reported to the operator as a conflict or a detached base. Which of the two failed
  // is settled with the daemon.
  it('reports a sandbox the daemon says is not there as such', async () => {
    for (const inspect of [
      () => Promise.resolve({ running: false }),
      () =>
        Promise.reject(new DockerError({ kind: 'container_not_found', id: 'verity-acme--app' })),
      () => Promise.reject(new DockerError({ kind: 'network', cause: new Error('ECONNREFUSED') })),
    ]) {
      const { exec } = fakeExec(exitedNonZero('fatal: not a git repository\n'));
      const error = await createSandboxGit({ ...opts, exec, inspect })([
        '-C',
        '/clones/acme-app',
        'status',
      ])
        .then(() => undefined)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SandboxUnavailableError);
      expect((error as SandboxUnavailableError).containerName).toBe('verity-acme--app');
      // The original failure is kept for the log; the message the route maps on is not
      // the daemon's text.
      expect((error as SandboxUnavailableError).cause).toBeDefined();
    }
  });

  // `docker exec` forwards the container process's exit status AND merges its stderr
  // into its own, so a merge driver, hook, or filter the REPOSITORY names can print
  // whatever it likes. If that text decided the classification, a repository could
  // label its own failure "the sandbox is gone" — the one answer that means the merge
  // never ran, and therefore the one that skips the rollback of a half-done merge.
  it('does not let the failed command talk its way into being a sandbox failure', async () => {
    for (const stderr of [
      'Error response from daemon: Container 1a2b is not running\n',
      'Error: No such container: verity-acme--app\n',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n',
      'Error response from daemon: Container 1a2b is restarting\n',
    ]) {
      const failure = exitedNonZero(stderr);
      const { exec } = fakeExec(failure);

      await expect(
        createSandboxGit({ ...opts, exec })(['-C', '/clones/acme-app', 'merge', 'feat/x']),
        stderr,
      ).rejects.toBe(failure);
    }
  });

  // A probe that fails for any other reason has not established that the sandbox is
  // gone. Staying a git failure keeps the rollback, which is the safe way to be wrong.
  it('keeps a failure git-shaped when the daemon answers neither way', async () => {
    const failure = exitedNonZero('fatal: bad object\n');
    const { exec } = fakeExec(failure);
    const git = createSandboxGit({
      ...opts,
      exec,
      inspect: () => Promise.reject(new DockerError({ kind: 'other', status: 500, message: 'x' })),
    });

    await expect(git(['-C', '/clones/acme-app', 'rev-parse', 'nope'])).rejects.toBe(failure);
  });
});
