import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_EGRESS_PLACEHOLDER } from '../packages/server/src/claude-egress-policy.js';

const review = fileURLToPath(new URL('../agent-seed/bin/verity-code-review', import.meta.url));
const tempRoots: string[] = [];

function fixture(): { bin: string; repo: string } {
  const repo = mkdtempSync(join(tmpdir(), 'verity-code-review-'));
  tempRoots.push(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'changed.txt'), 'base\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  execFileSync('git', ['-C', repo, 'branch', 'origin/main']);
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'test/review']);
  writeFileSync(join(repo, 'changed.txt'), 'changed\n');
  execFileSync('git', ['-C', repo, 'commit', '-qam', 'change']);
  mkdirSync(join(repo, 'agent-seed'));
  writeFileSync(join(repo, 'agent-seed', 'code-review-prompt.md'), 'Review this diff.');
  const bin = join(repo, 'bin');
  mkdirSync(bin);
  return { bin, repo };
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(repo: string, bin: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(review, ['run'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: '',
      PATH: `${bin}:${process.env.PATH}`,
      ...env,
    },
  });
}

const stubs: ChildProcess[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const stub of stubs.splice(0)) stub.kill();
});

/**
 * The stub server has to run in its OWN process: the reviewer is started with
 * `spawnSync`, which blocks this thread for as long as it runs, so an
 * in-process server would never get to answer the probe and every case that
 * depends on one would pass or fail for the wrong reason.
 */
const STUB_SERVER = `
  const http = require('node:http');
  const routes = JSON.parse(process.argv[1]);
  const handler = (request, response) => {
    const route = routes[request.url];
    if (route === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(route.status, { 'content-type': 'application/json' }).end(route.body);
  };
  http.createServer(handler).listen(0, '127.0.0.1', function () {
    const port = this.address().port;
    // Also answer on ::1 where the host has it, so the 'localhost' spelling
    // does not depend on curl falling back within the probe's timeout.
    const second = http.createServer(handler);
    const ready = () => process.stdout.write(port + '\\n');
    second.once('listening', ready);
    second.once('error', ready);
    second.listen(port, '::1');
  });
`;

/** A loopback HTTP server on an ephemeral port, so the probe in the wrapper
 * never reaches a connector that happens to be running on this machine. */
async function serve(routes: Record<string, { status: number; body: string }>): Promise<string> {
  const stub = spawn(process.execPath, ['-e', STUB_SERVER, JSON.stringify(routes)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  stubs.push(stub);
  const port = await new Promise<string>((resolve, reject) => {
    stub.stdout?.setEncoding('utf8');
    stub.stdout?.once('data', (chunk: string) => resolve(chunk.trim()));
    stub.once('error', reject);
    stub.once('exit', () => reject(new Error('stub server exited before listening')));
  });
  return `http://127.0.0.1:${port}`;
}

const READY_BODY = JSON.stringify({ protocolVersion: 1, ready: true });

const connector = async (): Promise<string> =>
  await serve({ '/__verity/ready': { status: 200, body: READY_BODY } });

describe('verity-code-review session backend', () => {
  it('uses Codex for a Codex session with its provisioned non-secret home', () => {
    const { bin, repo } = fixture();
    mkdirSync(join(repo, '.codex'));
    executable(
      join(bin, 'codex'),
      'test -n "${CODEX_HOME:-}"\n' +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "No findings.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );
    executable(join(bin, 'claude'), 'exit 99');

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'codex',
      CODEX_HOME: join(repo, '.codex'),
      HOME: repo,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via codex');
    expect(result.stdout).toContain('No findings.');
  });

  it('fails closed instead of discovering a credential-bearing Codex home', () => {
    const { bin, repo } = fixture();
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.codex', 'auth.json'), '{}');
    executable(join(bin, 'codex'), 'exit 99');

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'codex',
      HOME: repo,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CODEX_HOME is missing');
  });

  it('uses Claude Opus without filesystem tools for a Claude session', () => {
    const { bin, repo } = fixture();
    const claudeCwd = join(repo, 'claude-cwd');
    executable(join(bin, 'codex'), 'exit 99');
    executable(
      join(bin, 'claude'),
      'case " $* " in\n' +
        '  *" --model opus "*" --no-session-persistence "*" --setting-sources  "*" --tools  "*) ;;\n' +
        '  *) exit 3 ;;\n' +
        'esac\n' +
        `pwd >"${claudeCwd}"\n` +
        'test "$HOME" = "$(pwd)"\n' +
        'test "$CLAUDE_CONFIG_DIR" = "$(pwd)"\n' +
        'printf "No findings from Claude.\\n"',
    );

    const result = run(repo, bin, { VERITY_SESSION_BACKEND: 'claude' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via claude');
    expect(result.stdout).toContain('No findings from Claude.');
    expect(execFileSync('sed', ['-n', '1p', claudeCwd], { encoding: 'utf8' }).trim()).not.toBe(
      repo,
    );
  });

  it('picks the Claude reviewer from the CLI marker when the backend is unstamped', async () => {
    const { bin, repo } = fixture();
    executable(join(bin, 'codex'), 'exit 99');
    executable(join(bin, 'claude'), 'printf "No findings from Claude.\\n"');

    // A brokered Sandbox holds no Claude credential at all, so the reviewer has
    // to be chosen from the runtime that invoked it plus the egress it can still
    // authenticate with, not from an API key.
    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: '',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: await connector(),
      VERITY_CLAUDE_EGRESS: '',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via claude');
  });

  it('keeps Codex for a Claude runtime whose login the reviewer cannot inherit', () => {
    const { bin, repo } = fixture();
    // Claude Code outside a Sandbox: logged in through ~/.claude, which the
    // reviewer's emptied HOME discards. Choosing Claude here would fail the gate
    // as "Not logged in" where the historical Codex reviewer still works.
    executable(join(bin, 'claude'), 'exit 99');
    executable(
      join(bin, 'codex'),
      'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "Reviewed by Codex.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: '',
      CLAUDECODE: '1',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      VERITY_CLAUDE_EGRESS: '',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via codex');
  });

  it('picks the Claude reviewer from a credential it will still hold', () => {
    const { bin, repo } = fixture();
    executable(join(bin, 'codex'), 'exit 99');
    executable(join(bin, 'claude'), 'printf "No findings from Claude.\\n"');

    // No CLI marker — a wrapper, a hook or a shell may have dropped it — but an
    // inherited token authenticates the reviewer wherever HOME points.
    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: '',
      CLAUDECODE: '',
      ANTHROPIC_API_KEY: 'ambient-key',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      VERITY_CLAUDE_EGRESS: '',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via claude');
  });

  it('falls back to Codex when neither the backend nor a Claude runtime is visible', () => {
    const { bin, repo } = fixture();
    executable(join(bin, 'claude'), 'exit 99');
    executable(
      join(bin, 'codex'),
      'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "Reviewed by Codex.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: '',
      CLAUDECODE: '',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      VERITY_CLAUDE_EGRESS: '',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via codex');
  });

  describe('Claude egress placeholder', () => {
    function reviewerToken(env: NodeJS.ProcessEnv): string {
      const { bin, repo } = fixture();
      const seen = join(repo, 'token.txt');
      executable(join(bin, 'codex'), 'exit 99');
      executable(
        join(bin, 'claude'),
        `printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN:-<unset>}" >${JSON.stringify(seen)}\n` +
          'printf "No findings from Claude.\\n"',
      );

      const result = run(repo, bin, {
        VERITY_SESSION_BACKEND: 'claude',
        ANTHROPIC_BASE_URL: '',
        VERITY_CLAUDE_EGRESS: '',
        CLAUDE_CODE_OAUTH_TOKEN: '',
        ANTHROPIC_API_KEY: '',
        ...env,
      });

      expect(result.status, result.stderr).toBe(0);
      return readFileSync(seen, 'utf8').trim();
    }

    it('re-supplies it when the spawn broker marks this agent for egress', async () => {
      // The marker settles it without probing — the stub here is never asked for
      // /__verity/ready — but the base URL must still be the local connector,
      // since the placeholder means nothing to anything that does not rewrite it.
      const base = await connector();
      expect(reviewerToken({ VERITY_CLAUDE_EGRESS: '1', ANTHROPIC_BASE_URL: base })).toBe(
        CLAUDE_EGRESS_PLACEHOLDER,
      );
      expect(
        reviewerToken({
          VERITY_CLAUDE_EGRESS: '1',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        }),
      ).toBe('<unset>');
    });

    it('re-supplies it on a Sandbox image that predates the marker', async () => {
      const base = await connector();
      expect(reviewerToken({ ANTHROPIC_BASE_URL: base })).toBe(CLAUDE_EGRESS_PLACEHOLDER);
      // Same connector, spelled the other two ways Verity may bind it.
      expect(reviewerToken({ ANTHROPIC_BASE_URL: base.replace('127.0.0.1', 'localhost') })).toBe(
        CLAUDE_EGRESS_PLACEHOLDER,
      );
      expect(reviewerToken({ ANTHROPIC_BASE_URL: `${base}/` })).toBe(CLAUDE_EGRESS_PLACEHOLDER);
    });

    it('leaves an unrelated local Anthropic-compatible proxy untouched', async () => {
      // Loopback base URL, but not the connector: overriding auth that was
      // working would fail a review that had no reason to fail.
      const proxy = await serve({});
      expect(reviewerToken({ ANTHROPIC_BASE_URL: proxy })).toBe('<unset>');
      // Same, for a proxy whose error page happens to carry a ready-shaped
      // body: only a successful status counts as the connector answering.
      const errorPage = await serve({ '/__verity/ready': { status: 502, body: READY_BODY } });
      expect(reviewerToken({ ANTHROPIC_BASE_URL: errorPage })).toBe('<unset>');
    });

    it('leaves an ambient login untouched', async () => {
      expect(reviewerToken({})).toBe('<unset>');
      expect(reviewerToken({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })).toBe('<unset>');
      // The property that matters outside a Sandbox: a real token reaches the
      // reviewer verbatim, and even the connector probe does not overwrite it
      // with the placeholder.
      const base = await connector();
      expect(reviewerToken({ CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token' })).toBe('ambient-token');
      expect(
        reviewerToken({ CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token', ANTHROPIC_BASE_URL: base }),
      ).toBe('ambient-token');
      expect(
        reviewerToken({ CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token', VERITY_CLAUDE_EGRESS: '1' }),
      ).toBe('ambient-token');
    });

    it('does not probe a userinfo-disguised remote host', async () => {
      // `http://127.0.0.1:80@attacker.example/` satisfies a naive
      // `http://127.0.0.1:*` glob but resolves off-box; the authority is parsed
      // before anything is sent, so this never leaves the machine.
      const base = await connector();
      const port = new URL(base).port;
      expect(
        reviewerToken({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}@attacker.example/` }),
      ).toBe('<unset>');
      expect(reviewerToken({ ANTHROPIC_BASE_URL: 'http://127.0.0.1.attacker.example/' })).toBe(
        '<unset>',
      );
      // Authorities the parser must refuse outright rather than probe: a
      // non-numeric port, and a host it does not recognise as loopback.
      expect(reviewerToken({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:notaport/' })).toBe('<unset>');
      expect(reviewerToken({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:/' })).toBe('<unset>');
      expect(reviewerToken({ ANTHROPIC_BASE_URL: `http://127.0.0.2:${port}/` })).toBe('<unset>');
      expect(reviewerToken({ ANTHROPIC_BASE_URL: `ftp://127.0.0.1:${port}/` })).toBe('<unset>');
    });
  });

  it('keeps the placeholder literal in sync with the server policy constant', () => {
    // The wrapper is plain shell in the container image and cannot import the
    // TypeScript source of truth, so the copy is asserted here instead.
    expect(readFileSync(review, 'utf8')).toContain(
      `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_EGRESS_PLACEHOLDER}`,
    );
  });

  it('keeps the two seed copies byte-identical', () => {
    // The image is built from the toolkit copy; every test above reads the
    // agent-seed one, so a one-sided edit would ship an unreviewed wrapper.
    const mirror = fileURLToPath(
      new URL(
        '../features/verity-sandbox-toolkit/agent-seed/bin/verity-code-review',
        import.meta.url,
      ),
    );
    expect(readFileSync(mirror)).toEqual(readFileSync(review));
  });

  it('retains the historical Codex reviewer for an OpenCode session', () => {
    const { bin, repo } = fixture();
    executable(
      join(bin, 'codex'),
      'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "Reviewed by Codex.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'opencode',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('via codex');
    expect(result.stdout).toContain('Reviewed by Codex.');
  });
});
