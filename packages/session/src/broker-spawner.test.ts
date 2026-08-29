import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentLaunchSpec,
  PRIVILEGE_DROP_FLAGS,
  resolveAgentWorktreeRoots,
  resolveDockerGid,
  runAgentSpawnBroker,
  SHARED_SESSION_ROOT,
  trustedCliLaunchSpec,
  withinAgentWorktreeRoots,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import { createBrokerSpawner, SESSION_RUNTIME_ENV_KEYS } from './broker-spawner.js';

/**
 * Every argv the broker drops privileges for — each agent command and the
 * trusted-CLI arm — paired with the executable that ends its flag prefix and
 * with the name the failure message should blame.
 *
 * The boundary tests below run the whole set rather than one launch path: a
 * flag that survives in `agentLaunchSpec` but is dropped from
 * `trustedCliLaunchSpec` is exactly the asymmetric drift they exist to catch,
 * and a trusted CLI is reached through an agent turn, so it is the same
 * boundary either way.
 */
function privilegeDropLaunches(
  extra: { dockerGid?: string } = {},
): { path: string; args: string[]; executable: string }[] {
  const identity = { agentUid: 1000, agentGid: 1000, runnerUid: 1101, runnerGid: 1101, ...extra };
  const agent = (command: 'claude-agent-acp' | 'codex-acp', executable: string) => ({
    path: `agentLaunchSpec(${command})`,
    args: agentLaunchSpec({ command, args: [], cwd: '/work' }, identity).args,
    executable,
  });
  return [
    agent('claude-agent-acp', '/usr/local/bin/claude-agent-acp'),
    agent('codex-acp', '/usr/local/bin/codex-acp'),
    {
      path: 'trustedCliLaunchSpec',
      args: trustedCliLaunchSpec(
        { kind: 'trusted-cli', command: '/usr/bin/gh', args: [], cwd: '/work', secrets: [] },
        identity,
      ).args,
      executable: '/usr/bin/gh',
    },
  ];
}

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'verity-agent-broker-'));
  await chmod(runtimeDir, 0o770);
});

afterEach(async () => {
  await rm(runtimeDir, { recursive: true, force: true });
});

describe('agent spawn broker', () => {
  it('proxies streaming stdin/stdout/stderr while fixing the dropped identity launch', async () => {
    const launches: Array<{ command: string; args: string[] }> = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild: (command, args, options) => {
        launches.push({ command, args });
        return spawn(
          process.execPath,
          [
            '-e',
            "process.stderr.write('diagnostic');process.stdin.on('data',c=>process.stdout.write(c.toString().toUpperCase()));process.stdin.on('end',()=>process.exit(0))",
          ],
          options,
        );
      },
    });
    try {
      const spawner = createBrokerSpawner(broker.socketPath);
      const processHandle = spawner('claude-agent-acp', [], {
        cwd: runtimeDir,
        env: {},
        stdin: 'hello ',
        keepStdinOpen: true,
      });
      expect(processHandle.writeStdin?.('world')).toBe(true);
      processHandle.closeStdin?.();
      const chunks: string[] = [];
      for await (const chunk of processHandle.stdout) chunks.push(chunk);
      await expect(processHandle.exited).resolves.toBe(0);
      expect(chunks.join('')).toBe('HELLO WORLD');
      expect(processHandle.stderr()).toBe('diagnostic');
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        command: '/usr/bin/setpriv',
        args: expect.arrayContaining([
          '--reuid=1000',
          '--regid=1000',
          '--clear-groups',
          '--no-new-privs',
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--bounding-set=-all',
          '/usr/local/bin/claude-agent-acp',
        ]),
      });
      expect(
        agentLaunchSpec(
          { command: 'claude-agent-acp', args: [], cwd: runtimeDir },
          { agentUid: 1000, agentGid: 1000 },
        ).spawnOptions.detached,
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('does not expose Codex config to Claude children', async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      env: { CLAUDE_CONFIG_DIR: '/run/verity/claude', CODEX_HOME: '/run/verity/codex' },
      spawnChild: (_command, _args, options) => {
        environments.push(options.env as NodeJS.ProcessEnv);
        return spawn(process.execPath, ['-e', ''], options);
      },
    });
    try {
      const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
        cwd: runtimeDir,
        env: {},
      });
      await expect(handle.exited).resolves.toBe(0);
      expect(environments[0]?.CLAUDE_CONFIG_DIR).toBe('/run/verity/claude');
      expect(environments[0]?.CODEX_HOME).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('forwards the per-turn runtime context and nothing else from the caller env', async () => {
    const environments: NodeJS.ProcessEnv[] = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      env: { VERITY_SESSION_BACKEND: 'codex' },
      spawnChild: (_command, _args, options) => {
        environments.push(options.env as NodeJS.ProcessEnv);
        return spawn(process.execPath, ['-e', ''], options);
      },
    });
    try {
      const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
        cwd: runtimeDir,
        env: {
          VERITY_SESSION_BACKEND: 'claude',
          VERITY_SESSION_MODEL: 'opus',
          ANTHROPIC_API_KEY: 'caller-secret',
        },
      });
      await expect(handle.exited).resolves.toBe(0);
      // This turn's context wins over whatever the broker itself was started with,
      // because the backend can change between turns of one Sandbox.
      expect(environments[0]?.VERITY_SESSION_BACKEND).toBe('claude');
      expect(environments[0]?.VERITY_SESSION_MODEL).toBe('opus');
      expect(environments[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      await broker.close();
    }
  });

  it('rejects every session environment the runtime-context allowlist does not describe', async () => {
    const spawnChild = vi.fn();
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild,
    });
    const rejected = [
      // Not on the allowlist at all — the caller's ambient env pushed across.
      { ANTHROPIC_API_KEY: 'smuggled' },
      // Right key, wrong shape: neither reaches `spawn` as a usable value, and a
      // newline in an env value has no legitimate spelling.
      { VERITY_SESSION_BACKEND: 42 },
      { VERITY_SESSION_BACKEND: '' },
      { VERITY_SESSION_MODEL: 'opus\nPATH=/attacker' },
      // A backend name steers control flow in the in-Sandbox helpers that read
      // it, so it is held to a bare identifier rather than merely to printable
      // text — which a model id, whose spelling belongs to the provider, is.
      { VERITY_SESSION_BACKEND: 'claude; rm -rf /' },
      { VERITY_SESSION_BACKEND: '$(id)' },
      { VERITY_SESSION_BACKEND: '../../etc/passwd' },
      // Byte-capped, not char-capped: a multi-byte value must not slip past it.
      { VERITY_SESSION_MODEL: 'ä'.repeat(200) },
      { VERITY_SESSION_MODEL: 'x'.repeat(257) },
      // An allowlisted key alongside a rejected one must not launder it through.
      { VERITY_SESSION_BACKEND: 'claude', PATH: '/attacker/bin' },
      'not-an-object',
      // An array has no allowlisted key but zero entries, so a naive entry-count
      // check would wave it through as an accepted shape.
      [],
    ];
    try {
      for (const sessionEnv of rejected) {
        const received = await new Promise<string>((resolve, reject) => {
          const socket = createConnection(broker.socketPath);
          let buffered = '';
          socket.on('data', (chunk) => (buffered += chunk.toString('utf8')));
          socket.once('error', reject);
          socket.once('close', () => resolve(buffered));
          socket.once('connect', () =>
            socket.write(
              `${JSON.stringify({
                protocolVersion: 1,
                kind: 'spawn-agent',
                // A command that is still mapped: an unmapped one is refused as an
                // invalid REQUEST before the session environment is ever examined,
                // which would pass this assertion for the wrong reason.
                command: 'claude-agent-acp',
                args: [],
                cwd: runtimeDir,
                sessionEnv,
              })}\n`,
            ),
          );
        });
        expect(received, JSON.stringify(sessionEnv)).toContain('invalid agent session environment');
      }
      expect(spawnChild).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('keeps the runtime-context allowlist identical in all three places that name it', async () => {
    // The list is repeated because the three checks sit in different runtimes —
    // a TypeScript client, the worker's request-file validation, and the broker's
    // own plain-JS re-check. Adding a key to only one of them half-lands. The
    // client is the imported constant compared against, so only the other two
    // are read from disk here.
    //
    // The bundled worker under features/ carries a fourth copy, but it is
    // generated from this package rather than maintained: `check:runner-worker`
    // byte-compares it against a fresh build, asserted by
    // runner-supervisor-feature.test.ts, so a stale allowlist there fails CI as
    // an out-of-date bundle instead of as drift.
    const sources = [
      './runner-worker-entry.ts',
      '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs',
    ];
    for (const source of sources) {
      const text = await readFile(new URL(source, import.meta.url), 'utf8');
      // Every mention in the file, not the first list literal: a file that spells
      // its allowlist differently must fail here rather than match nothing and
      // pass vacuously. Compared as a set, so the order a file happens to name
      // them in is not load-bearing — but a VERITY_SESSION_* key mentioned in
      // one of these files and absent from the allowlist is meant to fail, since
      // these are exactly the files that decide what crosses the boundary.
      const mentioned = [...text.matchAll(/VERITY_SESSION_[A-Z_]+/gu)].map((match) => match[0]);
      expect([...new Set(mentioned)].sort(), source).toEqual([...SESSION_RUNTIME_ENV_KEYS].sort());
    }
  });

  it('keeps the worker’s brokered-tool gates naming their members', async () => {
    // `runner-worker-entry.ts` is a top-level script — it reads its request file and
    // starts a turn on import, so there is nothing to call. What can be pinned is the
    // shape of its two fail-closed re-checks, and they are worth pinning: the Server
    // decides which backends get a gateway bearer, and these are the Sandbox-side
    // re-checks that refuse one that arrives anyway. `opencode-acp` is an ACP backend
    // that is deliberately not admitted (ADR 0014 D1), so the day someone rewrites
    // either gate as "is this ACP" it silently starts accepting a bearer for OpenCode
    // turns. That edit has to fail here instead.
    const text = await readFile(new URL('./runner-worker-entry.ts', import.meta.url), 'utf8');
    for (const field of ['trustedCliExecution === true', 'mcpGatewayToken !== undefined']) {
      expect(text).toMatch(
        new RegExp(
          `request\\.${field} &&\\s*request\\.backend !== 'claude-acp' &&\\s*` +
            `request\\.backend !== 'codex-acp'`,
          'u',
        ),
      );
    }
  });

  it('refuses a gateway bearer the container has no endpoint to redeem', async () => {
    const text = await readFile(new URL('./runner-worker-entry.ts', import.meta.url), 'utf8');
    expect(text).toMatch(
      /request\.mcpGatewayToken !== undefined &&\s*\(mcpGatewayUrl === undefined \|\| mcpGatewayUrl === ''\)/u,
    );
    expect(text).toContain("mcpGatewayUrl === ''");
    expect(text).toMatch(
      /throw new Error\(\s*'the MCP gateway bearer has no VERITY_MCP_GATEWAY_URL/u,
    );
  });

  it('rejects every executable except the fixed agent allowlist before spawning', async () => {
    const spawnChild = vi.fn();
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild,
    });
    try {
      const processHandle = createBrokerSpawner(broker.socketPath)('bash', ['-c', 'id'], {
        cwd: '/work',
        env: {},
      });
      await expect(processHandle.exited).resolves.toBe(1);
      expect(processHandle.stderr()).toMatch(/invalid agent spawn request/);
      expect(spawnChild).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('refuses a root target identity', () => {
    expect(() =>
      agentLaunchSpec(
        { command: 'claude-agent-acp', args: [], cwd: '/work' },
        { agentUid: 0, agentGid: 1000 },
      ),
    ).toThrow(/non-root agent uid\/gid/);
  });

  // The broker is CONFIGURED with the Runner runtime GID — it owns the socket it
  // listens on with it — so handing it to the child is a one-word change somebody
  // will keep proposing, most plausibly to "fix" an agent that cannot reach
  // /run/verity-runner/supervisor.sock. That socket is the SERVER's (the Server
  // container carries the group via `group_add`); the agent has no business on it,
  // and the same group also unlocks `turns/*/events.jsonl` and each turn's
  // `control.sock` at 0660 — the record of the agent's own turn. ADR 0006 requires
  // the child to hold neither the Runner UID nor the runtime GID. Assert the GID
  // reaches neither launch path even when both are configured.
  it('never hands the agent or a trusted CLI the Runner runtime group', () => {
    for (const { path, args } of privilegeDropLaunches()) {
      expect(args, path).toContain('--clear-groups');
      expect(
        args.filter((argument) => /^--(?:groups|keep-groups|init-groups)/u.test(argument)),
        path,
      ).toEqual([]);
      expect(
        args.filter((argument) => argument.includes('1101')),
        path,
      ).toEqual([]);
    }
  });

  /**
   * ADR 0006 Amendment 1: the control-plane agent gets the docker group, and NOTHING else
   * changes.
   *
   * This is the only sanctioned variation on the privilege prefix, and it is a
   * substitution rather than an addition — util-linux accepts exactly one of
   * `--clear-groups`, `--groups`, `--keep-groups`, `--init-groups`, and
   * `--groups` SETS the supplementary list rather than adding to it. That is
   * what keeps ADR 0006 intact through the change: the child ends up holding one
   * group, the docker one, and still not the runtime GID that owns
   * `events.jsonl`, `control.sock` and `supervisor.sock`.
   *
   * Assert the runtime GID's absence explicitly rather than trusting the
   * substitution: `--groups=1101,986` would satisfy every other expectation here
   * while handing back exactly the forgery capability ADR 0006 forbids. The four
   * capability flags must survive untouched too — swapping the group flag is not
   * licence to relax the rest.
   */
  it('grants the docker group to a control-plane agent without restoring the runtime group', () => {
    for (const { path, args, executable } of privilegeDropLaunches({ dockerGid: '986' })) {
      expect(args.slice(0, args.indexOf(executable)), path).toEqual([
        '--reuid=1000',
        '--regid=1000',
        '--groups=986',
        '--no-new-privs',
        '--inh-caps=-all',
        '--ambient-caps=-all',
        '--bounding-set=-all',
      ]);
      expect(args, path).not.toContain('--clear-groups');
      expect(
        args.filter((argument) => argument.includes('1101')),
        path,
      ).toEqual([]);
    }
  });

  /**
   * The escalation this grant would otherwise open, and why the variable is not
   * trusted.
   *
   * A project Sandbox's image is built from that repository's own
   * `.devcontainer`, and the Server pins only the env names it lists, so a name
   * it does not list falls through from the image. A repo could ship
   * `ENV VERITY_AGENT_DOCKER_GID=1101` and — if the broker took the variable at
   * face value — hand its own agent the group that owns every turn journal. That
   * is the ADR 0006 forgery boundary broken by a file in the repository under
   * test, which is a far worse exposure than the control-plane grant itself.
   *
   * Two independent guards, because either alone leaves a gap: the value is
   * checked against the mounted inode (no socket, no grant — every project
   * Sandbox), and the runtime gid is refused outright whatever the inode says.
   */
  it('ignores a docker gid the mounted socket does not back', () => {
    // The hostile-image case: a project Sandbox has no daemon socket at all, so
    // a declared variable resolves to nothing.
    expect(
      resolveDockerGid({ VERITY_AGENT_DOCKER_GID: '1101' }, () => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
    // And a socket that exists but belongs to another group cannot be claimed by
    // naming a different one.
    expect(resolveDockerGid({ VERITY_AGENT_DOCKER_GID: '1101' }, () => 986)).toBeUndefined();
    // The genuine control-plane case still resolves.
    expect(resolveDockerGid({ VERITY_AGENT_DOCKER_GID: '986' }, () => 986)).toBe('986');
    expect(resolveDockerGid({}, () => 986)).toBeUndefined();
  });

  it('refuses the Runner runtime gid as a docker grant on every launch path', () => {
    // The second guard, independent of the inode: even a real socket owned by the
    // runtime gid cannot buy the agent that group.
    const identity = { agentUid: 1000, agentGid: 1000, runnerGid: 1101, dockerGid: '1101' };
    for (const { path, build } of [
      {
        path: 'agentLaunchSpec',
        build: () =>
          agentLaunchSpec(
            { command: 'claude-agent-acp' as const, args: [], cwd: '/work' },
            identity,
          ),
      },
      {
        path: 'trustedCliLaunchSpec',
        build: () =>
          trustedCliLaunchSpec(
            {
              kind: 'trusted-cli' as const,
              command: '/usr/bin/gh',
              args: [],
              cwd: '/work',
              secrets: [],
            },
            identity,
          ),
      },
    ]) {
      expect(build, path).toThrow(/refuses the Runner runtime gid/);
    }
  });

  // A value that cannot be a GID must not silently degrade to `--clear-groups`:
  // that produces a socket the agent cannot open, which is indistinguishable
  // from the feature not being deployed and is the exact failure ADR 0006 Amendment 1 exists
  // to end. Fail closed and loudly instead.
  it('refuses a docker group id that is not a positive integer', () => {
    for (const bad of ['0', '-1', 'docker', '1.5']) {
      expect(() =>
        agentLaunchSpec(
          { command: 'claude-agent-acp', args: [], cwd: '/work' },
          { agentUid: 1000, agentGid: 1000, dockerGid: bad },
        ),
      ).toThrow(/positive docker group id/);
    }
  });

  // `--clear-groups` is only the flag somebody has already proposed dropping.
  // Every flag beside it reduces the child the same way — `--no-new-privs` is
  // what keeps a setuid binary from undoing the drop, the three capability
  // flags are what keep a file capability from handing back what the UID gave
  // up — and each of them is equally deletable by an edit that "only" tidies an
  // argv. Pin the whole prefix, exactly and in order, on every launch path, so
  // that removing or reordering one flag at one site fails here rather than in
  // production. (The identity flags come first and are pinned with them: an
  // argv that forgot `--reuid` would run the agent as the Runner.)
  it('drops the same privileges, in the same order, on every launch path', () => {
    for (const { path, args, executable } of privilegeDropLaunches()) {
      expect(args, path).toContain(executable);
      expect(args.slice(0, args.indexOf(executable)), path).toEqual([
        '--reuid=1000',
        '--regid=1000',
        ...PRIVILEGE_DROP_FLAGS,
      ]);
    }
  });

  // The denials those flags buy are only measurable as root on Linux, so the real
  // proof is `scripts/test-runner-forgery-boundary.mjs` in CI — and that script
  // spells the setpriv argv out itself rather than importing this module (it is
  // bind-mounted alone into the server image, with no repo beside it). Nothing
  // else stops the two from drifting, which is how the boundary could be dropped
  // in the broker while the test that checks it stays green against flags nobody
  // launches with any more — or tightened in the script while production stays
  // loose. Compare the two lists exactly, so neither side can move alone: this
  // fails whether a flag leaves the broker, leaves the script, or is added to
  // only one of them. The identity flags are interpolated there, so the match
  // requires them by position instead.
  //
  // What this parity does NOT cover, since ADR 0006 Amendment 1. It compares the
  // CONSTANT, and the constant is what a project Sandbox launches with — the
  // control-plane Runner launches with `privilegeDropFlags(dockerGid)`, whose
  // first element is `--groups=<docker-gid>` instead. So the CI script proves the
  // denials for project Sandboxes only; that is the scope the amendment assigns
  // it ("its scope narrowed; its assertions did not"), and it is the scope that
  // matters, because that is where repository code runs. The gap a reader should
  // worry about — a broker that quietly started passing `dockerGid` on every
  // launch, leaving this parity green while nothing launched with
  // `--clear-groups` — is closed by the default-path test above, which pins the
  // no-`dockerGid` argv to this same constant on every launch path.
  it('keeps the privilege flags identical to the CI forgery-boundary script', async () => {
    const boundary = await readFile(
      new URL('../../../scripts/test-runner-forgery-boundary.mjs', import.meta.url),
      'utf8',
    );
    const argv =
      /`--reuid=\$\{AGENT_UID\}`,\s*`--regid=\$\{AGENT_GID\}`,([\s\S]*?)process\.execPath,/u.exec(
        boundary,
      );
    expect(
      argv,
      'scripts/test-runner-forgery-boundary.mjs no longer spells out a setpriv argv this test can read',
    ).not.toBeNull();
    expect([...(argv?.[1] ?? '').matchAll(/'([^']+)'/gu)].map(([, flag]) => flag)).toEqual([
      ...PRIVILEGE_DROP_FLAGS,
    ]);
  });

  it('loads changed connector routing for each spawn without restarting the broker', async () => {
    const connectorConfigPath = join(runtimeDir, 'egress-connector.url');
    const environments: NodeJS.ProcessEnv[] = [];
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      connectorConfigPath,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild: (_command, _args, options) => {
        environments.push(options.env ?? {});
        return spawn(process.execPath, ['-e', ''], options);
      },
    });
    try {
      const spawner = createBrokerSpawner(broker.socketPath);
      const before = spawner('claude-agent-acp', [], { cwd: runtimeDir, env: {} });
      await expect(before.exited).resolves.toBe(0);
      await writeFile(connectorConfigPath, 'http://127.0.0.1:47821\n', { mode: 0o600 });
      await chmod(connectorConfigPath, 0o600);
      const after = spawner('claude-agent-acp', [], { cwd: runtimeDir, env: {} });
      await expect(after.exited).resolves.toBe(0);
      expect(environments[0]).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      expect(environments[1]).toMatchObject({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
        CLAUDE_CODE_OAUTH_TOKEN: 'verity-claude-egress-placeholder-v1', // gitleaks:allow
      });
    } finally {
      await broker.close();
    }
  });

  it('refuses argv for opencode-acp, which could otherwise reset the cwd it validated', async () => {
    // The cwd check two tests down is what confines an agent to the worktree, and
    // `opencode acp` accepts `--cwd`: a request could pass the check with a legal
    // directory and then name another one in its argv, keeping the broker-supplied
    // child environment. Verity's OpenCode profile sends no arguments, so refusing
    // them outright costs nothing and leaves the boundary with one meaning.
    const spawnChild = vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) =>
      spawn(process.execPath, ['-e', ''], options),
    );
    const outside = await mkdtemp(join(tmpdir(), 'verity-agent-outside-'));
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild,
    });
    try {
      const spawner = createBrokerSpawner(broker.socketPath);
      const refused = spawner('opencode-acp', ['--cwd', outside], { cwd: runtimeDir, env: {} });
      await expect(refused.exited).resolves.toBe(1);
      expect(refused.stderr()).toMatch(/opencode-acp takes no argv/);
      expect(spawnChild).not.toHaveBeenCalled();
      // The other adapters keep their argv: they have no flag that can move the
      // working directory, and the e2e paths pass the adapter's own module path.
      const allowed = spawner('claude-agent-acp', ['--verbose'], { cwd: runtimeDir, env: {} });
      await expect(allowed.exited).resolves.toBe(0);
      expect(spawnChild).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('canonicalizes cwd and rejects a symlink that escapes the worktree root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'verity-agent-outside-'));
    await symlink(outside, join(runtimeDir, 'escape'));
    const spawnChild = vi.fn();
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild,
    });
    try {
      const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
        cwd: join(runtimeDir, 'escape'),
        env: {},
      });
      await expect(handle.exited).resolves.toBe(1);
      expect(handle.stderr()).toMatch(/escaped the worktree root/);
      expect(spawnChild).not.toHaveBeenCalled();
    } finally {
      await broker.close();
      await rm(outside, { recursive: true, force: true });
    }
  });

  /**
   * A project Sandbox has one tree (`/work`); the control-plane Runner has two,
   * because the Server allocates control-plane session worktrees under
   * `workspacesDir` (`/srv/verity/sessions`) rather than inside the
   * `verity-control` clone, and `runnerSandboxPath` leaves that shared namespace
   * unrewritten on purpose. The Runner container mounts it beside `/work` for
   * exactly that reason. These pin both namespaces, and pin that the second one
   * is opt-in — a Sandbox that never configures it must stay confined to `/work`.
   */
  describe('shared control-plane session namespace', () => {
    let workRoot: string;
    let sessionRoot: string;

    beforeEach(async () => {
      workRoot = await mkdtemp(join(tmpdir(), 'verity-agent-work-'));
      sessionRoot = await mkdtemp(join(tmpdir(), 'verity-agent-sessions-'));
    });

    afterEach(async () => {
      await rm(workRoot, { recursive: true, force: true });
      await rm(sessionRoot, { recursive: true, force: true });
    });

    const spawnAt = async (
      options: { sharedSessionRoot?: string },
      cwd: string,
    ): Promise<{ exited: number | null; stderr: string; cwds: unknown[] }> => {
      const cwds: unknown[] = [];
      const broker = await runAgentSpawnBroker({
        runtimeDir,
        worktreeRoot: workRoot,
        enforceRoot: false,
        agentUid: 1000,
        agentGid: 1000,
        ...options,
        spawnChild: (_command, _args, spawnOptions) => {
          cwds.push(spawnOptions.cwd);
          return spawn(process.execPath, ['-e', ''], spawnOptions);
        },
      });
      try {
        const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
          cwd,
          env: {},
        });
        return { exited: await handle.exited, stderr: handle.stderr(), cwds };
      } finally {
        await broker.close();
      }
    };

    it('runs a control-plane session worktree out of the shared session namespace', async () => {
      const worktree = join(sessionRoot, 'agent-control-1');
      await mkdir(worktree);
      const result = await spawnAt({ sharedSessionRoot: sessionRoot }, worktree);
      expect(result.stderr).not.toMatch(/escaped the worktree root/);
      expect(result.exited).toBe(0);
      expect(result.cwds).toEqual([await realpath(worktree)]);
    });

    it('still runs a project session worktree out of the project mount', async () => {
      const worktree = join(workRoot, '.verity-sessions', 'agent-project-1');
      await mkdir(worktree, { recursive: true });
      const result = await spawnAt({ sharedSessionRoot: sessionRoot }, worktree);
      expect(result.exited).toBe(0);
      expect(result.cwds).toEqual([await realpath(worktree)]);
    });

    it('keeps a Sandbox without the shared mount confined to its project root', async () => {
      const worktree = join(sessionRoot, 'agent-control-2');
      await mkdir(worktree);
      const result = await spawnAt({}, worktree);
      expect(result.exited).toBe(1);
      expect(result.stderr).toMatch(/agent cwd escaped the worktree root/);
      expect(result.cwds).toEqual([]);
    });

    it('refuses a cwd that is outside every configured root', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'verity-agent-elsewhere-'));
      try {
        const result = await spawnAt({ sharedSessionRoot: sessionRoot }, outside);
        expect(result.exited).toBe(1);
        expect(result.stderr).toMatch(/agent cwd escaped the worktree root/);
        expect(result.cwds).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses to start when the configured shared root is not mounted', async () => {
      await expect(
        runAgentSpawnBroker({
          runtimeDir,
          worktreeRoot: workRoot,
          sharedSessionRoot: join(sessionRoot, 'never-mounted'),
          enforceRoot: false,
          agentUid: 1000,
          agentGid: 1000,
          spawnChild: () => {
            throw new Error('unreachable');
          },
        }),
      ).rejects.toThrow(/shared session root is not a mounted directory/);
    });

    /**
     * The trusted-CLI branch carries its own copy of the guard, so the shared
     * root has to reach it too — a control-plane session running `verity_secret_run`
     * stands in the same worktree its agent does.
     */
    const trustedCli = async (
      options: { sharedSessionRoot?: string },
      cwd: string,
    ): Promise<{ response: { ok?: boolean; error?: string }; cwds: unknown[] }> => {
      const cwds: unknown[] = [];
      const broker = await runAgentSpawnBroker({
        runtimeDir,
        worktreeRoot: workRoot,
        enforceRoot: false,
        agentUid: 1000,
        agentGid: 1000,
        // The default `/usr/local/bin` is user-owned on a developer machine and
        // would fail the immutability rule before the cwd guard is reached.
        env: { PATH: '/usr/bin' },
        ...options,
        spawnChild: (_command, _args, spawnOptions) => {
          cwds.push(spawnOptions.cwd);
          return spawn(process.execPath, ['-e', ''], spawnOptions);
        },
      });
      try {
        const response = await new Promise<{ ok?: boolean; error?: string }>((resolve, reject) => {
          const socket = createConnection(broker.socketPath);
          let buffered = '';
          socket.once('error', reject);
          socket.on('data', (chunk: Buffer) => {
            buffered += chunk.toString('utf8');
            const newline = buffered.indexOf('\n');
            if (newline < 0) return;
            socket.destroy();
            resolve(JSON.parse(buffered.slice(0, newline)) as { ok?: boolean; error?: string });
          });
          socket.once('connect', () => {
            socket.write(
              `${JSON.stringify({
                protocolVersion: 1,
                kind: 'spawn-trusted-cli',
                command: '/usr/bin/true',
                args: [],
                cwd,
                secrets: [{ name: 'VERITY_TEST_TOKEN', value: 'x', injection: 'env' }],
              })}\n`,
            );
          });
        });
        return { response, cwds };
      } finally {
        await broker.close();
      }
    };

    it('runs a trusted CLI from the shared session namespace, and only when configured', async () => {
      const worktree = join(sessionRoot, 'agent-control-3');
      await mkdir(worktree);
      const allowed = await trustedCli({ sharedSessionRoot: sessionRoot }, worktree);
      expect(allowed.response.error).toBeUndefined();
      expect(allowed.response.ok).toBe(true);
      expect(allowed.cwds).toEqual([await realpath(worktree)]);

      const refused = await trustedCli({}, worktree);
      expect(refused.response).toMatchObject({
        ok: false,
        error: 'trusted CLI cwd escaped the worktree root',
      });
      expect(refused.cwds).toEqual([]);
    });

    it('canonicalizes both roots and pins the production shared root', async () => {
      const link = join(sessionRoot, 'link');
      await symlink(workRoot, link);
      expect(await resolveAgentWorktreeRoots({ worktreeRoot: link })).toEqual([
        await realpath(workRoot),
      ]);
      const roots = await resolveAgentWorktreeRoots({
        worktreeRoot: workRoot,
        sharedSessionRoot: sessionRoot,
      });
      expect(roots).toEqual([await realpath(workRoot), await realpath(sessionRoot)]);
      expect(withinAgentWorktreeRoots(join(roots[1]!, 'agent-x'), roots)).toBe(true);
      expect(withinAgentWorktreeRoots(join(roots[0]!, '.verity-sessions', 'a'), roots)).toBe(true);
      expect(withinAgentWorktreeRoots(`${roots[1]!}-sibling`, roots)).toBe(false);
      // The default stays the single project mount, and the opt-in root is the
      // literal the control-plane Runner mounts — not anything a caller names.
      expect(await resolveAgentWorktreeRoots({ worktreeRoot: workRoot })).toHaveLength(1);
      expect(SHARED_SESSION_ROOT).toBe('/srv/verity/sessions');
    });
  });

  it('kills a pending child when its Runner connection detaches before spawn', async () => {
    class DelayedChild extends EventEmitter {
      pid: number | undefined;
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      stdin = new PassThrough();
      stdout = new PassThrough();
      stderr = new PassThrough();
      readonly kill = vi.fn((signal: NodeJS.Signals) => {
        if (this.pid === undefined) return false;
        this.signalCode = signal;
        queueMicrotask(() => this.emit('close', null, signal));
        return true;
      });
      spawnNow(): void {
        this.pid = 4242;
        this.emit('spawn');
      }
    }
    const child = new DelayedChild();
    let notifySpawnCalled: () => void = () => undefined;
    const spawnCalled = new Promise<void>((resolve) => (notifySpawnCalled = resolve));
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild: () => {
        notifySpawnCalled();
        return child as unknown as ChildProcess;
      },
    });
    const socket = createConnection(broker.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({
            protocolVersion: 1,
            kind: 'spawn-agent',
            command: 'claude-agent-acp',
            args: [],
            cwd: runtimeDir,
          })}\n`,
          () => resolve(),
        );
      });
    });
    await spawnCalled;
    socket.destroy();
    child.spawnNow();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'));
    await broker.close();
  });

  it('rejects malformed and oversized frames without spawning', async () => {
    const spawnChild = vi.fn();
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      maxFrameBytes: 64,
      spawnChild,
    });
    try {
      for (const payload of ['not-json\n', `${'x'.repeat(65)}\n`]) {
        await new Promise<void>((resolve) => {
          const socket = createConnection(broker.socketPath);
          socket.on('data', () => undefined);
          socket.once('error', () => resolve());
          socket.once('close', () => resolve());
          socket.once('connect', () => socket.end(payload));
        });
      }
      expect(spawnChild).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it('closes an accepted connection after an invalid pipelined control frame', async () => {
    let child: ChildProcess | undefined;
    const broker = await runAgentSpawnBroker({
      runtimeDir,
      worktreeRoot: runtimeDir,
      enforceRoot: false,
      agentUid: 1000,
      agentGid: 1000,
      spawnChild: (_command, _args, options) => {
        child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
        return child;
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(broker.socketPath);
        let response = '';
        let sentInvalid = false;
        socket.once('error', reject);
        socket.on('data', (chunk) => {
          response += chunk.toString('utf8');
          if (!sentInvalid && response.includes('"kind":"spawned"')) {
            sentInvalid = true;
            socket.write(
              `${JSON.stringify({ protocolVersion: 1, kind: 'invalid-control' })}\n${JSON.stringify({ protocolVersion: 1, kind: 'stdin', data: Buffer.from('ignored').toString('base64') })}\n`,
            );
          }
        });
        socket.once('close', resolve);
        socket.once('connect', () =>
          socket.write(
            `${JSON.stringify({
              protocolVersion: 1,
              kind: 'spawn-agent',
              command: 'claude-agent-acp',
              args: [],
              cwd: runtimeDir,
            })}\n`,
          ),
        );
      });
      await vi.waitFor(() => expect(child?.signalCode).toBe('SIGKILL'));
    } finally {
      await broker.close();
    }
  });
});

/**
 * The client half of the broker protocol, driven against a scripted peer.
 *
 * The tests above run the REAL broker, which only ever speaks the protocol
 * correctly: it cannot emit a malformed frame, a refusal without a reason, an exit
 * reported as a bare signal, or a socket that closes with no `exit` frame at all.
 * Those are precisely the cases {@link createBrokerSpawner} classifies into an exit
 * code plus a stderr tail, and getting one wrong turns a broken turn into a silently
 * "clean" exit. A scripted peer is the only way to produce them deterministically.
 */
interface ScriptedBroker {
  socketPath: string;
  /** Every frame the spawner wrote, in order. */
  readonly requests: Record<string, unknown>[];
  /** Resolves with the `spawn-agent` frame once the spawner has sent it. */
  readonly spawnRequest: Promise<Record<string, unknown>>;
  /** Write raw bytes to the connected spawner (one `write` = one wire chunk). */
  write: (text: string) => void;
  /** Write the given frames as one chunk of newline-delimited JSON. */
  send: (...frames: unknown[]) => void;
  /** Half-close the connection without sending anything further. */
  end: () => void;
}

const scriptedBrokers: Array<() => Promise<void>> = [];

/** Snapshotted at import, before any test reassigns `TMPDIR`: a unix socket path
 * is capped at ~104 bytes, and the scratch-cleanup tests above repoint `TMPDIR`
 * into a nested temporary tree. Binding under the original root keeps these paths
 * short no matter what ran first. */
const SCRIPTED_TMP_ROOT = tmpdir();
let scriptedDir: string;

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function startScriptedBroker(): Promise<ScriptedBroker> {
  const socketPath = join(scriptedDir, `scripted-${randomUUID().slice(0, 8)}.sock`);
  const requests: Record<string, unknown>[] = [];
  let peer: Socket | undefined;
  let announceSpawn: (frame: Record<string, unknown>) => void = () => undefined;
  const spawnRequest = new Promise<Record<string, unknown>>((resolve) => {
    announceSpawn = resolve;
  });
  let buffered = '';
  const server = createServer((socket) => {
    peer = socket;
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        requests.push(frame);
        if (frame.kind === 'spawn-agent') announceSpawn(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  scriptedBrokers.push(
    () =>
      new Promise<void>((resolve) => {
        peer?.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    socketPath,
    requests,
    spawnRequest,
    write: (text) => void peer?.write(text),
    send: (...frames) => void peer?.write(frames.map((f) => `${JSON.stringify(f)}\n`).join('')),
    end: () => void peer?.end(),
  };
}

describe('broker spawner protocol handling', () => {
  beforeEach(async () => {
    scriptedDir = await mkdtemp(join(SCRIPTED_TMP_ROOT, 'verity-broker-peer-'));
  });

  afterEach(async () => {
    await Promise.all(scriptedBrokers.splice(0).map((close) => close()));
    await rm(scriptedDir, { recursive: true, force: true });
  });

  /** Connect the spawner to `broker` and wait until its `spawn-agent` frame lands. */
  async function connect(
    broker: ScriptedBroker,
    options: { keepStdinOpen?: boolean; stdin?: string } = {},
  ) {
    const handle = createBrokerSpawner(broker.socketPath)('claude-agent-acp', [], {
      cwd: scriptedDir,
      env: {},
      ...options,
    });
    await broker.spawnRequest;
    return handle;
  }

  // A broker that answers with something other than JSON is a broker whose own
  // framing broke. Reporting the last agent diagnostic instead would blame the
  // agent for the transport's failure, so the tail is REPLACED, not appended to.
  it('replaces the stderr tail with the malformed-frame diagnostic', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.write(
      `${JSON.stringify({ ok: true, kind: 'stderr', data: base64('agent diagnostic') })}\nnot-json\n`,
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('spawn broker returned malformed JSON');
  });

  // Every `ok:false` frame is a refusal reason the operator needs; a second one
  // must not overwrite the first, and a refusal with no reason still has to say
  // something rather than reading as an empty failure.
  it('joins successive broker refusals and keeps the first exit code', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.send(
      { ok: false, error: 'invalid agent spawn request' },
      { ok: false },
      { ok: true, kind: 'exit', code: 42 },
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toBe('invalid agent spawn request\nspawn broker failed');
  });

  // POSIX 128+signum, so a killed agent is never reported as a clean 0. An
  // unrecognised signal name has no number, and must not silently become one.
  it('maps a signal-only exit to 128 + the signal number', async () => {
    const killed = await startScriptedBroker();
    const killedHandle = await connect(killed);
    killed.send(
      { ok: true, kind: 'spawned', pid: 4242 },
      { ok: true, kind: 'exit', signal: 'SIGKILL' },
    );
    await expect(killedHandle.exited).resolves.toBe(137);
    expect(killedHandle.pid).toBe(4242);

    const unknown = await startScriptedBroker();
    const unknownHandle = await connect(unknown);
    unknown.send({ ok: true, kind: 'spawned' }, { ok: true, kind: 'exit', signal: 'SIGNOTREAL' });
    await expect(unknownHandle.exited).resolves.toBe(128);
    expect(unknownHandle.pid).toBeUndefined();
  });

  // No socket means no turn. The OS error is the only diagnostic that exists, and
  // dropping it leaves a failed turn with an empty stderr and exit 1.
  it('reports the connection error when the broker socket is unreachable', async () => {
    const handle = createBrokerSpawner(join(scriptedDir, 'no-such-broker.sock'))(
      'claude-agent-acp',
      [],
      {
        cwd: scriptedDir,
        env: {},
      },
    );

    await expect(handle.exited).resolves.toBe(1);
    expect(handle.stderr()).toMatch(/ENOENT.*no-such-broker\.sock/u);
  });

  it('settles a connection the broker closed without an exit frame', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.end();

    await expect(handle.exited).resolves.toBe(1);
    // Empty: this is the close path, not the socket-error path.
    expect(handle.stderr()).toBe('');
  });

  // A cancel that lands between `spawn-agent` and `spawned` has nothing to signal
  // yet. Dropping it would leave the agent running with the Server believing it
  // cancelled the turn, so the signal is parked and replayed on spawn.
  it('parks a pre-spawn kill until the child exists and ignores an unsupported signal', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    // SIGHUP is not a signal this transport carries; parking it would overwrite the
    // real cancel that arrived first.
    handle.kill('SIGKILL');
    handle.kill('SIGHUP');
    expect(broker.requests.map((frame) => frame.kind)).toEqual(['spawn-agent']);

    broker.send({ ok: true, kind: 'spawned', pid: 77 });
    await vi.waitFor(() => expect(broker.requests).toHaveLength(3));
    expect(broker.requests.slice(1)).toEqual([
      { protocolVersion: 1, kind: 'close-stdin' },
      { protocolVersion: 1, kind: 'signal', signal: 'SIGKILL' },
    ]);

    // Once spawned, a signal goes straight out — and the default is SIGTERM.
    handle.kill();
    await vi.waitFor(() => expect(broker.requests).toHaveLength(4));
    expect(broker.requests[3]).toEqual({ protocolVersion: 1, kind: 'signal', signal: 'SIGTERM' });
  });

  // Steering input (#101) rides the same socket. What must never happen is a write
  // after EOF being reported as accepted: the caller would drop a message it was
  // told had been delivered.
  it('streams stdin through after spawn and refuses it once stdin is closed', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker, { keepStdinOpen: true });

    expect(handle.writeStdin?.('queued ')).toBe(true);
    broker.send({ ok: true, kind: 'spawned', pid: 7 });
    await vi.waitFor(() => expect(broker.requests).toHaveLength(2));

    expect(handle.writeStdin?.('live')).toBe(true);
    await vi.waitFor(() => expect(broker.requests).toHaveLength(3));

    handle.closeStdin?.();
    await vi.waitFor(() => expect(broker.requests).toHaveLength(4));
    // Idempotent: a second close is not a second EOF frame.
    handle.closeStdin?.();
    expect(handle.writeStdin?.('after close')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(broker.requests.slice(1)).toEqual([
      { protocolVersion: 1, kind: 'stdin', data: base64('queued ') },
      { protocolVersion: 1, kind: 'stdin', data: base64('live') },
      { protocolVersion: 1, kind: 'close-stdin' },
    ]);
  });

  // An agent that outruns its reader would otherwise queue its whole stdout in
  // this process's heap. Past the high-water mark the socket stops being read, so
  // the backlog is held in the kernel — which also means nothing behind it (here,
  // the turn's `exit`) is processed until the consumer catches up.
  it('stops reading the broker socket past the stdout high-water mark', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);
    const payload = 'x'.repeat(1024 * 1024 + 1);

    broker.send(
      { ok: true, kind: 'spawned', pid: 9 },
      { ok: true, kind: 'stdout', data: base64(payload) },
    );
    // Let the whole frame land and the queue trip its high-water mark before the
    // next frame is written, so `exit` is behind a socket that is no longer read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    broker.send({ ok: true, kind: 'exit', code: 7 });

    await expect(
      Promise.race([
        handle.exited,
        new Promise((resolve) => setTimeout(() => resolve('still-paused'), 250)),
      ]),
    ).resolves.toBe('still-paused');

    const chunks: string[] = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    expect(chunks).toEqual([payload]);
    await expect(handle.exited).resolves.toBe(7);
  });

  // The turn ends at its `exit` frame. Anything the broker wrote after it belongs
  // to no turn and must not reach the consumer, or a settled turn's transcript
  // grows output nobody can attribute.
  it('drops stdout written after the exit frame and then reports the stream done', async () => {
    const broker = await startScriptedBroker();
    const handle = await connect(broker);

    broker.send(
      { ok: true, kind: 'spawned', pid: 3 },
      { ok: true, kind: 'stdout', data: base64('before') },
      { ok: true, kind: 'exit', code: 5 },
      { ok: true, kind: 'stdout', data: base64('after') },
      { ok: true, kind: 'exit', code: 9 },
    );

    await expect(handle.exited).resolves.toBe(5);
    const chunks: string[] = [];
    for await (const chunk of handle.stdout) chunks.push(chunk);
    expect(chunks).toEqual(['before']);
  });
});
