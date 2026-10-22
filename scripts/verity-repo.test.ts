// `verity-repo` is the agent's only way to open pull requests on Forgejo (and,
// later, every code host). The tests run the real script against a fake Verity
// server, for both the repository seed and the toolkit copy baked into images.
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOTS = ['agent-seed/bin', 'features/verity-sandbox-toolkit/agent-seed/bin'] as const;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Handler = (body: Record<string, unknown>, reply: ServerResponse) => void;

async function fixture(handler: Handler, options: { branch?: string | null; url?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verity-repo-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  git('init', '-q', '-b', options.branch ?? 'feat/7-search');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  if (options.branch === null) git('checkout', '-q', '--detach');
  const capability = join(root, 'capability');
  writeFileSync(capability, 'cap-fixture\n');
  const calls: Record<string, unknown>[] = [];
  const server = createServer((request, reply) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      expect(request.url).toBe('/internal/project/repo');
      expect(request.headers.authorization).toBe('Bearer cap-fixture');
      const parsed = JSON.parse(body) as Record<string, unknown>;
      calls.push(parsed);
      handler(parsed, reply);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const run = (binRoot: string, args: string[], stdin = '') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn('bash', [resolve(binRoot, 'verity-repo'), ...args], {
        cwd: root,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          VERITY_PROJECT_REPO_URL:
            options.url === false ? '' : `http://127.0.0.1:${address.port}/internal/project/repo`,
          VERITY_GH_BROKER_CAPABILITY_FILE: capability,
          VERITY_REPO_TIMEOUT_SECONDS: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  return { calls, run };
}

const ok = (payload: unknown) => (_body: Record<string, unknown>, reply: ServerResponse) =>
  reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));

const pull = {
  number: 12,
  title: 'Add search',
  url: 'https://git.example.org/team/site/pulls/12',
  state: 'open',
  draft: false,
  head: 'feat/7-search',
  base: 'main',
  body: 'Closes #7',
};

describe.each(ROOTS)('verity-repo (%s)', (binRoot) => {
  it('opens a pull request for the current branch', async () => {
    const { calls, run } = await fixture(ok({ host: 'Forgejo', pullRequest: pull }));
    const result = await run(
      binRoot,
      ['pr', 'create', '--title', 'Add search', '--body-file', '-'],
      'Closes #7',
    );
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout.trim()).toBe(
      'Opened pull request #12 on Forgejo: https://git.example.org/team/site/pulls/12',
    );
    // No base: the server picks the project's default branch, not the sandbox.
    expect(calls).toEqual([
      { action: 'pr.create', title: 'Add search', body: 'Closes #7', head: 'feat/7-search' },
    ]);
  });

  it('marks the current branch pull request ready, or a numbered one', async () => {
    const { calls, run } = await fixture(ok({ host: 'GitHub', pullRequest: pull }));
    expect((await run(binRoot, ['pr', 'ready'])).stdout).toContain('#12 is ready for review');
    await run(binRoot, ['pr', 'ready', '12']);
    expect(calls).toEqual([
      { action: 'pr.ready', head: 'feat/7-search' },
      { action: 'pr.ready', number: 12 },
    ]);
  });

  it('lists and views issues and comments on them', async () => {
    const issue = {
      number: 7,
      title: 'Search',
      url: 'https://git.example.org/team/site/issues/7',
      state: 'open',
      body: 'Details',
      labels: ['feature'],
    };
    const { calls, run } = await fixture((body, reply) =>
      ok(
        body.action === 'issue.list'
          ? { host: 'Forgejo', issues: [issue] }
          : body.action === 'issue.view'
            ? { host: 'Forgejo', issue }
            : { host: 'Forgejo', comment: { url: 'https://git.example.org/c/1' } },
      )(body, reply),
    );
    expect((await run(binRoot, ['issue', 'list'])).stdout.trim()).toBe('#7\tSearch\t[feature]');
    expect((await run(binRoot, ['issue', 'view', '7'])).stdout).toContain('labels: feature');
    expect((await run(binRoot, ['issue', 'comment', '7', '--body', 'On it'])).stdout.trim()).toBe(
      'Commented: https://git.example.org/c/1',
    );
    expect(calls.at(-1)).toEqual({ action: 'issue.comment', number: 7, body: 'On it' });
  });

  it('prints the raw response with --json', async () => {
    const { run } = await fixture(ok({ host: 'Forgejo', pullRequest: pull }));
    const result = await run(binRoot, ['pr', 'view', '12', '--json']);
    expect(JSON.parse(result.stdout)).toEqual({ host: 'Forgejo', pullRequest: pull });
  });

  // A pull request the agent believes it opened must never silently not exist.
  it('fails loudly with the server reason', async () => {
    const { run } = await fixture((_body, reply) =>
      reply
        .writeHead(409, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'pull request #12 is already open for feat/7-search' })),
    );
    const result = await run(binRoot, ['pr', 'create', '--title', 'Again']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      'verity-repo: pull request #12 is already open for feat/7-search',
    );
  });

  // The server may have opened the pull request before the answer was lost, so
  // "unreachable" would invite the retry that opens a second one.
  it('reports a timed-out write as possibly completed', async () => {
    const { calls, run } = await fixture(() => undefined);
    const result = await run(binRoot, ['pr', 'create', '--title', 'Slow']);
    expect(calls).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('timed out and may have completed');
    expect(result.stderr).not.toContain('unreachable');
  });

  it('refuses incomplete commands before calling the server', async () => {
    const { calls, run } = await fixture(ok({}), { branch: null });
    expect((await run(binRoot, ['pr', 'create'])).stderr).toContain('needs --title');
    expect((await run(binRoot, ['pr', 'ready'])).stderr).toContain('not on a branch');
    expect((await run(binRoot, ['issue', 'view', 'seven'])).stderr).toContain('not a number');
    expect((await run(binRoot, ['issue', 'comment', '7'])).stderr).toContain('needs --body');
    expect((await run(binRoot, ['pr', 'merge'])).code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('explains a sandbox without the repository broker', async () => {
    const { run } = await fixture(ok({}), { url: false });
    const result = await run(binRoot, ['issue', 'list']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('VERITY_PROJECT_REPO_URL unset');
  });
});

it('keeps the toolkit copy identical to the agent seed', () => {
  expect(readFileSync(resolve(ROOTS[1], 'verity-repo'), 'utf8')).toBe(
    readFileSync(resolve(ROOTS[0], 'verity-repo'), 'utf8'),
  );
});
