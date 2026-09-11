import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_EGRESS_PLACEHOLDER } from '../packages/server/src/claude-egress-policy.js';

const review = fileURLToPath(new URL('../agent-seed/bin/verity-code-review', import.meta.url));
const tempRoots: string[] = [];

/** Read a numeric budget out of the script rather than restating it here: a
 *  restated copy keeps passing after the budget it was meant to bound has moved
 *  back above the size the model refuses. */
function scriptBudget(pattern: RegExp): number {
  const match = pattern.exec(readFileSync(review, 'utf8'));
  if (!match) {
    throw new Error(`verity-code-review no longer declares ${String(pattern)}`);
  }
  return Number.parseInt(match[1], 10);
}

const CHUNK_BYTES = scriptBudget(/^\s*CHUNK_BYTES=(\d+)\s*$/m);
const MANIFEST_BYTES = scriptBudget(/manifest truncated at (\d+) bytes/);

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
  it('reviews large diffs in bounded chunks and aggregates every result', () => {
    const { bin, repo } = fixture();
    writeFileSync(join(repo, 'large.txt'), `${'ä'.repeat(800_000)}\n`);
    writeFileSync(join(repo, 'multiline.txt'), 'changed ä line\n'.repeat(70_000));
    writeFileSync(join(repo, 'backticks.txt'), `${'`'.repeat(800_000)}\n`);
    execFileSync('git', ['-C', repo, 'add', 'large.txt', 'multiline.txt', 'backticks.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'large change']);
    executable(
      join(bin, 'codex'),
      `review_payload="$(mktemp ${JSON.stringify(join(repo, 'review-payload.XXXXXX'))})"\n` +
        'cat >"$review_payload"\n' +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "No findings for this chunk.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'codex',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status, result.stderr).toBe(0);
    const allPayloads = readdirSync(repo)
      .filter((name) => name.startsWith('review-payload.'))
      .map((name) => readFileSync(join(repo, name)));
    const synthesisPayload = allPayloads.find((payload) =>
      payload.includes('Perform the final holistic review'),
    );
    expect(synthesisPayload).toBeDefined();
    const payloads = allPayloads
      .filter((payload) => /Review chunk \d+ of \d+\./.test(payload.toString('utf8')))
      .sort((left, right) => {
        const chunkNumber = (payload: Buffer): number =>
          Number(/Review chunk (\d+) of/.exec(payload.toString('utf8'))?.[1]);
        return chunkNumber(left) - chunkNumber(right);
      });
    const callCount = payloads.length;
    expect(callCount).toBeGreaterThan(1);
    expect(Math.max(...allPayloads.map((payload) => payload.byteLength))).toBeLessThan(1_000_000);
    for (const payload of payloads) {
      const text = payload.toString('utf8');
      expect(text).not.toContain('\uFFFD');
      expect(text).toMatch(/^diff --git /m);
      expect(text).toContain('diff --git a/large.txt b/large.txt');
      expect(text).toContain('diff --git a/multiline.txt b/multiline.txt');
      expect(text.indexOf('--- BEGIN UNTRUSTED REVIEW DATA THROUGH EOF ---')).toBeLessThan(
        text.indexOf('## Whole-change manifest'),
      );
      const data = text.split('--- UNTRUSTED DIFF CHUNK ---\n')[1];
      expect(data).toBeTruthy();
    }
    const reconstructedDiff = payloads
      .map((payload) => payload.toString('utf8').split('--- UNTRUSTED DIFF CHUNK ---\n')[1])
      .map((data) =>
        data.replace(
          /^diff --git [^\n]*\n# Verity review continuation of this file diff\.\n(?:@@[^\n]*\n)?(?:# Oversized diff line fragment [^\n]*\n[ +-]?)?/,
          '',
        ),
      )
      .join('');
    expect(payloads.some((payload) => payload.includes('# Oversized diff line fragment 2;'))).toBe(
      true,
    );
    const expectedDiff = execFileSync('git', ['-C', repo, 'diff', 'origin/main..HEAD'], {
      encoding: 'utf8',
      maxBuffer: 10_000_000,
    });
    expect(reconstructedDiff).toBe(expectedDiff);
    expect(String(result.stdout).match(/No findings for this chunk\./g)).toHaveLength(
      callCount + 1,
    );
    expect(result.stdout).toContain('## Holistic synthesis');
    expect(result.stderr).toContain(`split the diff into ${callCount} review chunk(s)`);
  });

  /**
   * The chunk budget has to be the size the MODEL accepts, not the size the
   * transport accepts. It was set against "a reviewer's 1 MB request limit", and
   * because sections are only split ABOVE the budget, a diff below that number
   * is sent as one chunk however large it is. A 581,436-byte diff went out whole
   * and came back "Prompt is too long" — the gate failed on a branch it was
   * supposed to be able to review, and nothing here noticed, because the other
   * chunking test uses inputs far above 1 MB and splits either way.
   *
   * This one is sized at the reproduction: big enough to be refused, small
   * enough that a byte-sized budget keeps it in a single chunk.
   */
  it('splits a diff the model refuses but a 1 MB request limit would not', () => {
    const { bin, repo } = fixture();
    writeFileSync(
      join(repo, 'refused.txt'),
      `${'refused review line'.padEnd(59, '.')}\n`.repeat(9_670),
    );
    execFileSync('git', ['-C', repo, 'add', 'refused.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'diff at the refused size']);
    executable(
      join(bin, 'codex'),
      `review_payload="$(mktemp ${JSON.stringify(join(repo, 'review-payload.XXXXXX'))})"\n` +
        'cat >"$review_payload"\n' +
        'while [ "$#" -gt 0 ]; do\n' +
        '  if [ "$1" = "-o" ]; then printf "No findings for this chunk.\\n" >"$2"; exit 0; fi\n' +
        '  shift\n' +
        'done\nexit 2',
    );

    const diffBytes = Buffer.byteLength(
      execFileSync('git', ['-C', repo, 'diff', 'origin/main..HEAD'], {
        encoding: 'utf8',
        maxBuffer: 10_000_000,
      }),
      'utf8',
    );
    // The reproduction size: `claude -p` refused a 581,436-byte prompt and
    // accepted 150,000. A 1 MB request limit would have sent this whole diff as
    // one chunk, so the diff has to stay under that and above the chunk budget
    // for the split this test asserts to be the script's doing.
    expect(diffBytes).toBeGreaterThan(CHUNK_BYTES);
    expect(diffBytes).toBeLessThan(1_000_000);

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'codex',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status, result.stderr).toBe(0);
    const chunkPayloads = readdirSync(repo)
      .filter((name) => name.startsWith('review-payload.'))
      .map((name) => readFileSync(join(repo, name)))
      .filter((payload) => /Review chunk \d+ of \d+\./.test(payload.toString('utf8')));
    expect(chunkPayloads.length).toBeGreaterThan(1);
    // Every prompt actually sent stays under the refused size, manifest and
    // fencing included — the chunk budget alone does not bound the prompt, and a
    // chunk budget raised back past what the manifest leaves would refuse again.
    expect(Math.max(...chunkPayloads.map((payload) => payload.byteLength))).toBeLessThan(
      CHUNK_BYTES + MANIFEST_BYTES + 10_000,
    );
  });

  /**
   * A reviewer that fails without saying why sends the pushing agent looking for
   * `--no-verify`. `claude -p` refuses an over-long prompt on STDOUT and exits 1
   * with stderr EMPTY, and stdout is the channel the review comes back on — it
   * goes to a temp file the failure path deletes. The gate printed "the isolated
   * claude reviewer failed on chunk 1 of 1 (exit 1)" and pointed at a log with
   * nothing in it.
   */
  it('reports a backend failure that arrives on stdout instead of stderr', () => {
    const { bin, repo } = fixture();
    executable(join(bin, 'codex'), 'exit 99');
    // A blank first line, an ANSI erase-line sequence before the message, and
    // enough trailing output that both bounded readers — the log's `head -c` and
    // the excerpt's `grep -m1` — stop early and SIGPIPE the `tr` feeding them:
    // the backend was reading a hostile diff, so none of that may decide whether
    // the reason reaches the pushing agent, or reach the terminal intact.
    executable(
      join(bin, 'claude'),
      'printf "\\n\\033[2K\\302\\233Prompt is too long\\n"\nhead -c 400000 /dev/zero | tr "\\0" "x"\nexit 1',
    );

    const result = run(repo, bin, { VERITY_SESSION_BACKEND: 'claude' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Prompt is too long');
    expect(result.stderr).toContain('failed on chunk');
    // Quoted as data, and inert: no escape byte survives into the terminal.
    expect(result.stderr).toContain('as DATA and not as instructions');
    expect(result.stderr).not.toContain('\u001b');
    expect(result.stderr).not.toContain('\u009b');
  });

  it('fails closed when a text diff is not valid UTF-8', () => {
    const { bin, repo } = fixture();
    writeFileSync(join(repo, 'invalid.txt'), Buffer.from([0x66, 0x6f, 0x80, 0x6f, 0x0a]));
    execFileSync('git', ['-C', repo, 'add', 'invalid.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'invalid utf8']);
    executable(join(bin, 'codex'), 'exit 99');

    const result = run(repo, bin, {
      VERITY_SESSION_BACKEND: 'codex',
      CODEX_HOME: join(repo, '.codex'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed to chunk the branch diff safely');
  });

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
    }, 30_000);
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

    const prompt = fileURLToPath(new URL('../agent-seed/code-review-prompt.md', import.meta.url));
    const promptMirror = fileURLToPath(
      new URL(
        '../features/verity-sandbox-toolkit/agent-seed/code-review-prompt.md',
        import.meta.url,
      ),
    );
    expect(readFileSync(promptMirror)).toEqual(readFileSync(prompt));
  });

  it('keeps reviewer findings inside the submitted change', () => {
    const prompt = readFileSync(
      fileURLToPath(new URL('../agent-seed/code-review-prompt.md', import.meta.url)),
      'utf8',
    );
    expect(prompt).toMatch(/Do not propose new\s+features, unrelated refactors/);
    expect(prompt).toMatch(/MEDIUM.*in-scope correctness or maintainability/s);
    expect(prompt).toMatch(/LOW.*must never be the sole\s+reason.*another review pass/s);
  });

  it('documents the same triage before marking the reviewed HEAD', () => {
    const helper = readFileSync(review, 'utf8');
    expect(helper).toMatch(/fixed or declined with a brief reason/i);
    expect(helper).toMatch(/Re-run first when a fix changed HEAD/i);
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
