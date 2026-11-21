import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  agentLaunchSpec,
  validateTrustedCliExecutable,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { execFileAsync } from './runner-supervisor-feature.test-helper.js';

let runtimeDir: string;
beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-runner-supervisor-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});
describe('verity-runner supervisor runtime', () => {
  it('allows only immutable root-owned trusted CLI executables', async () => {
    await expect(validateTrustedCliExecutable('/usr/bin/env')).resolves.toBeUndefined();
    const directory = await mkdtemp(join(tmpdir(), 'verity-trusted-cli-'));
    const executable = join(directory, 'tool');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(validateTrustedCliExecutable(executable)).rejects.toThrow(
      /root-owned and immutable/u,
    );
  });

  it('installs the trusted CLIs it ships root-owned, as its own broker demands', async () => {
    // Release tarballs carry their publisher's CI ownership (gh and doppler both record
    // uid/gid 1001), and tar restores it when the Feature runs as root. Shipped that
    // way, every `verity_secret_run` against those binaries is refused by the validator
    // above — the toolkit would hand the broker executables the broker exists to reject.
    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    const extractions = installer
      .split('\n')
      .filter((line) => /\btar\b/u.test(line) && line.includes('-xz'));
    expect(extractions.length).toBeGreaterThan(0);
    for (const extraction of extractions) expect(extraction).toContain('--no-same-owner');
    expect(installer).toMatch(/install_trusted_cli_ownership\(\)\s*\{\s*\n\s*chown root:root/u);
    expect(installer).toContain('install_trusted_cli_ownership /usr/local/bin/doppler');
    expect(installer).toContain('install_trusted_cli_ownership /usr/local/lib/verity/gh-real');
  });

  it('installs the supervisor at the path the refresh runbook tells operators to read', async () => {
    // That runbook's last step is a `docker exec … grep <pattern> <path>`, and it is the
    // only thing separating "the recreation did not take" from "the recreation did not
    // help" — nothing on the wire carries a boundary-binary version. Both halves of that
    // command can rot silently and both rot in the dangerous direction: a path the
    // installer no longer writes answers `0` for a container that is perfectly current,
    // and a pattern that is not specific to the ADMISSION list answers non-zero for a
    // stale one, since a pre-amendment supervisor has spawned OpenCode workers for
    // releases and names it throughout. Prose notices neither.
    const runbook = await readFile(
      'docs/runbooks/opencode-brokered-tools-container-refresh.md',
      'utf8',
    );
    const command = /grep -c "([^"]+)" (\/\S+)/u.exec(runbook);
    expect(command).not.toBeNull();
    const [, pattern, documented] = command!;

    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    // The path on its own, not the surrounding `install` invocation: pinning the line
    // continuation and its indent would report a reformat of the installer as a rename.
    // Escaped first — the path comes out of prose, and its `.`-bearing siblings would
    // otherwise match an installer path that merely looks like the documented one.
    const escaped = documented!.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
    expect(installer).toMatch(
      new RegExp(`verity-runner-supervisor\\.mjs"\\s*\\\\?\\s*${escaped}(?!\\S)`, 'u'),
    );

    // Run the operator's pattern through the operator's tool. Re-reading a BRE as a JS
    // regex is not the same language — bracket expressions and line bounding both
    // differ — and a test that passes on a pattern `grep` rejects would certify the one
    // command this page cannot afford to have wrong.
    const supervisorPath = 'features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
    const supervisor = await readFile(supervisorPath, 'utf8');
    const count = async (path: string): Promise<string> => {
      // grep exits 1 on no match, which execFile reports as a rejection.
      const run = await execFileAsync('grep', ['-c', pattern!, path]).catch(
        (error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }),
      );
      return run.stdout.trim();
    };
    expect(await count(supervisorPath)).toBe('1');

    // And that it DISCRIMINATES, which is the property the operator's conclusion rests
    // on. Take OpenCode back out of the admission list — the pre-amendment supervisor,
    // which still names it everywhere else — and the command must answer `0`.
    // Either quote: this is the shipped bundle, whose declaration the bundler rewrites.
    const stale = supervisor.replace(
      /(ACP_WORKER_BACKENDS = [^\n]*?new Set\(\[[^\]]*), ["']opencode-acp["']/u,
      '$1',
    );
    expect(stale).not.toBe(supervisor);
    expect(stale).toContain('opencode-acp');
    const staleDir = await mkdtemp(join(tmpdir(), 'verity-stale-supervisor-'));
    onTestFinished(async () => {
      await rm(staleDir, { recursive: true, force: true });
    });
    const stalePath = join(staleDir, 'verity-runner-supervisor');
    await writeFile(stalePath, stale);
    expect(await count(stalePath)).toBe('0');
  });

  it('writes the opencode-acp wrapper root-owned and keeps it out of the dev chown', async () => {
    // The wrapper is what turns one fixed command name into one fixed executable
    // for OpenCode (ADR 0012 Amendment 4, security invariant 1) — the broker execs
    // `/usr/local/bin/opencode-acp` and passes no shell, so the `acp` subcommand
    // has to be baked in on this side. Three properties carry that, and each is one
    // careless edit from silently regressing: the wrapper's own content, its root
    // ownership, and its deliberate absence from `WRITTEN_PATHS`, whose only
    // protection today is a comment — that array drives the F11 chown to the dev
    // user, and handing the file to the identity the agent runs as would let an
    // agent turn choose which binary the next one starts.
    //
    // The wrapper now has two installers — this Feature and the Server image, which
    // is what the control-plane Runner runs (ADR 0012 Amendment 6) — so it is
    // defined once, in the script below, and both run it. Read the properties there
    // and read the invocation here; `scripts/agent-cli-pins.test.ts` is what keeps
    // either from inlining a second copy.
    const [installer, wrapperScript] = await Promise.all([
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
      readFile('features/verity-sandbox-toolkit/bin/verity-opencode-acp-install.sh', 'utf8'),
    ]);
    expect(installer).toContain('bin/verity-opencode-acp-install.sh');
    expect(wrapperScript).toContain(
      `printf '#!/bin/sh\\nexec %s acp "$@"\\n' "$OPENCODE_BIN" > "$OPENCODE_ACP_TMP"`,
    );
    expect(wrapperScript).toContain(
      'install -o root -g root -m 0755 "$OPENCODE_ACP_TMP" /usr/local/bin/opencode-acp',
    );
    const written = installer
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .filter((line) => line.includes('WRITTEN_PATHS+='));
    expect(written.length).toBeGreaterThan(0);
    for (const line of written) expect(line).not.toContain('opencode-acp');
    // Fail the build, not the first turn: nothing has a fallback for a missing
    // executable, so an image that requested opencode and cannot find it must stop
    // here rather than ship looking complete and ENOENT at spawn.
    expect(wrapperScript).toContain('cannot build opencode-acp');
    expect(wrapperScript).toContain('exit 1');
  });

  it('installs no bubblewrap, in the Feature or in the image that bakes it', async () => {
    // The package is absent on purpose, and the reason is the opposite of the
    // obvious one: Codex logs "Codex could not find bubblewrap on PATH." at ERROR
    // level on every start, which reads like an unmet prerequisite and is not one
    // — Verity always bypasses Codex's own sandbox. Installing bwrap to silence
    // that line switches ON Claude's inner sandbox, which is redundant with this
    // container and loses its injected /etc/resolv.conf, taking DNS with it
    // (packages/session/src/codex-backend.ts). The rationale is a comment block
    // in install.sh; this is what makes it survive a hurried package addition.
    //
    // Both files are checked because either can install it and only one carries
    // the rationale. The Dockerfile installs no packages today, so it contributes
    // no lines — the point is that the moment it does, they are covered.
    const [installer, dockerfile] = await Promise.all([
      readFile('features/verity-sandbox-toolkit/install.sh', 'utf8'),
      readFile('deploy/verity-sandbox.Dockerfile', 'utf8'),
    ]);
    const uncommented = (source: string): string[] =>
      source.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    // Scoped to the lines that actually name packages rather than to the file
    // text: the rationale above the list says "bubblewrap" several times, and a
    // future `command -v bwrap` guard would be legitimate. Neither should decide
    // this test.
    const packageLines = [
      ...uncommented(installer).filter((line) => /APT_PACKAGES=\(|apt(-get)? install/u.test(line)),
      ...uncommented(dockerfile).filter((line) => /apt(-get)? install|apk add/u.test(line)),
    ];
    for (const line of packageLines) expect(line).not.toMatch(/\bbubblewrap\b|\bbwrap\b/u);
    // Guards the guard: the extraction must still find the list it is filtering,
    // or every assertion above passes by reading nothing at all.
    expect(packageLines.filter((line) => line.includes('APT_PACKAGES=('))).toHaveLength(1);
  });

  it('stages every release download before it unpacks it', async () => {
    // `curl … | tar -xz` cannot be retried. A transfer that dies mid-body has
    // already fed the decompressor the truncated prefix, so curl restarting from
    // byte zero puts a second copy behind it and the pipeline dies on
    // "unexpected end of file" with attempts to spare — one dropped connection
    // to a release CDN failing the whole image build. Observed in CI, and
    // invisible in review because the retry flags are right there in the line.
    const installer = await readFile('features/verity-sandbox-toolkit/install.sh', 'utf8');
    expect(installer).not.toMatch(/\|\s*tar\b/u);
    const extractions = installer
      .split('\n')
      .filter((line) => /\btar\b/u.test(line) && line.includes('-xz'));
    expect(extractions.length).toBeGreaterThan(0);
    // Every unpack reads a file that was downloaded in full first.
    for (const extraction of extractions) expect(extraction).toContain('-xzf "$DOWNLOAD_DIR/');
    expect(installer).toContain('--retry-all-errors');
  });

  it('forwards CLAUDE_CONFIG_DIR through the broker so the transcript lands on the mount', () => {
    // Stage-5b Slice 2b: the container sets CLAUDE_CONFIG_DIR to the shared
    // runner-runtime mount; the broker must thread its own env through the
    // allowlist so Claude honours it and writes its session .jsonl where the
    // server-side tail persists it. The CLI entry supplies `env: process.env`.
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          PATH: '/usr/bin',
          CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
        },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
    });
  });
});
