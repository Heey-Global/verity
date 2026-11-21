import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_EGRESS_PLACEHOLDER } from './claude-egress-policy.js';
import { agentLaunchSpec } from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
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
  it.each(['codex-acp', 'claude-agent-acp', 'opencode-acp'] as const)(
    'preserves forge transport in the actual %s launch environment',
    (command) => {
      const forge = {
        VERITY_FORGE_MODE: 'proxy-test',
        VERITY_FORGE_AUTHORITY: 'forge.example:3000',
        VERITY_PROJECT_REPO_URL: 'http://verity-project-relay:8080/internal/project/repo',
        VERITY_FORGE_PROXY_URL: 'http://verity-project-relay:8080',
        VERITY_FORGE_PROXY_CA_FILE: '/run/verity/forge-proxy/ca.crt',
        GIT_TERMINAL_PROMPT: '0',
      };
      const spec = agentLaunchSpec(
        { command, args: [], cwd: '/work/project' },
        {
          agentUid: 1000,
          agentGid: 1000,
          connectorUrl: 'http://127.0.0.1:47821',
          env: { ...forge, GH_TOKEN: 'must-not-cross' },
        },
      );
      expect(spec.spawnOptions.env).toMatchObject(forge);
      expect(spec.spawnOptions.env).not.toHaveProperty('GH_TOKEN');
    },
  );
  it.each(['codex-acp', 'claude-agent-acp', 'opencode-acp'] as const)(
    'resolves the guarded Git binary after a lifecycle launch of %s',
    async (command) => {
      const wrappers = join(runtimeDir, 'agent-seed', 'bin');
      const shims = join(runtimeDir, 'package-managers');
      const interpreter = join(runtimeDir, 'root-owned-node', 'bin');
      for (const directory of [wrappers, shims, interpreter]) {
        await mkdir(directory, { recursive: true });
      }
      for (const [directory, executable] of [
        [wrappers, 'git'],
        [shims, 'npm'],
        [interpreter, 'node'],
      ] as const) {
        await writeFile(join(directory, executable), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      const lifecyclePath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      const spec = agentLaunchSpec(
        { command, args: [], cwd: '/work/project' },
        {
          agentUid: 1000,
          agentGid: 1000,
          connectorUrl: 'http://127.0.0.1:47821',
          env: { PATH: `${interpreter}:${lifecyclePath}` },
        },
      );
      // Map image-owned directories into the fixture; CI need not install the toolkit in /opt.
      const environment = spec.spawnOptions.env ?? {};
      const path = (environment.PATH ?? '')
        .split(':')
        .map((entry) =>
          entry === '/opt/agent-seed/bin'
            ? wrappers
            : entry === '/opt/verity/package-managers'
              ? shims
              : entry,
        );
      const result = await execFileAsync(
        '/bin/sh',
        ['-c', 'command -v git; command -v npm; command -v node'],
        { env: { ...environment, PATH: path.join(':') } },
      );
      expect(result.stdout.trim().split('\n')).toEqual([
        join(wrappers, 'git'),
        join(shims, 'npm'),
        join(interpreter, 'node'),
      ]);
      expect(environment.PATH).toBe(
        `/opt/verity/package-managers:/opt/agent-seed/bin:${interpreter}:${lifecyclePath}`,
      );
    },
  );
  it('restores system command lookup when the broker inherits an empty PATH', () => {
    const spec = agentLaunchSpec(
      { command: 'codex-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: { PATH: '' },
      },
    );
    expect(spec.spawnOptions.env?.PATH).toBe(
      '/opt/verity/package-managers:/opt/agent-seed/bin:/usr/local/bin:/usr/bin:/bin',
    );
  });
  it('passes only the local Claude connector coordinates through the root broker', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          PATH: '/usr/bin',
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
          VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
      // The CLI strips the placeholder from its own children, so an in-Sandbox
      // helper that must re-supply it needs this to say so unambiguously.
      VERITY_CLAUDE_EGRESS: '1',
    });
    expect(spec.spawnOptions.detached).toBe(true);
    expect(spec.spawnOptions.env).not.toHaveProperty('VERITY_AGENT_GATEWAY_CLIENT_KEY_FILE');
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('launches Claude ACP through its fixed binary with the same secret-free connector env', () => {
    const spec = agentLaunchSpec(
      { command: 'claude-agent-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
          CLAUDE_CODE_EXECUTABLE: '/work/project/attacker-controlled',
          CLAUDE_CODE_HARBOR_KITE: '1',
          CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('/usr/local/bin/claude-agent-acp');
    expect(spec.spawnOptions.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:47821',
      CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude',
      // Without it every session of the project opens an inbox any sibling session
      // can write to, and agents message each other past session links unseen.
      CLAUDE_CODE_HARBOR_KITE: '0',
      // Without it the CLI withholds its task-list tools from models outside its
      // allowlist, and no plan checklist ever reaches the app.
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      CLAUDE_CONFIG_DIR: '/run/verity-runner/claude',
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_EGRESS_PLACEHOLDER,
      // Both Claude transports are marked, so an in-Sandbox helper never has to
      // fall back to probing the connector on one of them.
      VERITY_CLAUDE_EGRESS: '1',
    });
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  // The command→binary map is the last check before a privileged `setpriv` exec, and
  // it replaced a chain that fell back to the native `claude` binary (ADR 0012). An
  // unmapped command must fail there — including the inherited object keys a plain
  // literal would have resolved to a truthy function, sailing past the guard.
  // `opencode` is in that family twice over: it is the retired native transport's
  // name AND a multi-purpose CLI, so a request that reached it would choose the
  // subcommand. Only the `opencode-acp` wrapper is spawnable.
  it.each(['claude', 'opencode', 'constructor', 'valueOf', 'toString', '__proto__'])(
    'refuses to launch the unmapped agent command %p',
    (command) => {
      expect(() =>
        agentLaunchSpec(
          // The typed union is exactly what this guard has to hold up without: the
          // request crossed a socket, so the cast reproduces a caller that bypassed it.
          { command, args: [], cwd: '/work/project' } as Parameters<typeof agentLaunchSpec>[0],
          { agentUid: 1000, agentGid: 1000, connectorUrl: 'http://127.0.0.1:47821', env: {} },
        ),
      ).toThrow('unsupported agent command');
    },
  );

  it('launches Codex ACP through its fixed binary, pinned to the image Codex and free of secrets', () => {
    const spec = agentLaunchSpec(
      { command: 'codex-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          CODEX_HOME: '/run/verity-runner/codex',
          // A request that could pick these would run an attacker's Codex, log
          // into a browser flow, or downgrade the sandbox posture.
          CODEX_PATH: '/work/project/attacker-controlled',
          NO_BROWSER: '0',
          INITIAL_AGENT_MODE: 'read-only',
          OPENAI_API_KEY: 'must-not-cross',
          VERITY_CODEX_PLACEHOLDER: 'attacker-controlled',
          DOPPLER_TOKEN: 'must-not-cross',
          GITHUB_TOKEN: 'must-not-cross',
        },
      },
    );
    expect(spec.args).toContain('/usr/local/bin/codex-acp');
    expect(spec.args).not.toContain('/work/project/attacker-controlled');
    expect(spec.spawnOptions.env).toMatchObject({
      CODEX_HOME: '/run/verity-runner/codex',
      // codex-acp bundles its own @openai/codex; without this pin two Codex
      // versions run in the same image.
      CODEX_PATH: '/usr/local/bin/codex',
      NO_BROWSER: '1',
      // Reproduces the native transport's posture, never taken from the request.
      INITIAL_AGENT_MODE: 'agent-full-access',
      VERITY_CODEX_PLACEHOLDER: 'verity-codex-gateway-placeholder-v1',
    });
    expect(spec.spawnOptions.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('DOPPLER_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    // The Claude connector coordinates belong to the Claude transports only.
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('VERITY_CLAUDE_EGRESS');
  });

  it.each([{ planning: true }, { knowledgeIsolation: true }])(
    'requires private process metadata for confined OpenCode: %j',
    (isolation) => {
      const spec = agentLaunchSpec(
        {
          command: 'opencode-acp',
          args: [],
          cwd: '/work/project',
          knowledgeHome: '/tmp/home',
          ...isolation,
        },
        {
          agentUid: 1000,
          agentGid: 1000,
          connectorUrl: 'http://127.0.0.1:47821',
          env: { VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE: '0' },
        },
      );
      expect(spec.args).toContain('--self-proc-maps');
      expect(spec.spawnOptions.env).not.toHaveProperty(
        'VERITY_SCRIPT_SANDBOX_FORCE_MOUNT_NAMESPACE',
      );
      expect(spec.args).toContain(isolation.planning ? '--read-only-root' : '--write-isolated');
    },
  );

  it('launches OpenCode ACP through the fixed wrapper, with XDG_CONFIG_HOME and no secrets', () => {
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          XDG_CONFIG_HOME: '/run/verity/xdg',
          OPENCODE_CONFIG: '/run/verity/opencode-config/opencode.json',
          OPENCODE_DISABLE_PROJECT_CONFIG: '0',
          OPENCODE_PURE: '0',
          OPENCODE_CONFIG_CONTENT: '{"agent":{"plan":{"permission":{"edit":"allow"}}}}',
          OPENCODE_CONFIG_DIR: '/work/project/.opencode',
          OPENCODE_ENABLE_EXA: '0',
          OPENCODE_WEBSEARCH_PROVIDER: 'parallel',
          EXA_API_KEY: 'must-not-cross',
          OPENAI_API_KEY: 'must-not-cross',
          DOPPLER_TOKEN: 'must-not-cross',
          GITHUB_TOKEN: 'must-not-cross',
        },
      },
    );
    // The wrapper, never the `opencode` binary: that CLI is multi-purpose, so a
    // command name reaching it would let the request's argv pick the subcommand.
    expect(spec.args).toContain('/usr/local/bin/opencode-acp');
    expect(spec.args).not.toContain('/usr/local/bin/opencode');
    // OpenCode keeps its own writable files under XDG and reads Verity's provider
    // config from a separate read-only mount. Without either path the turn dies on
    // the first prompt or while OpenCode initializes its config directory.
    expect(spec.spawnOptions.env).toMatchObject({
      XDG_CONFIG_HOME: '/run/verity/xdg',
      OPENCODE_CONFIG: '/run/verity/opencode-config/opencode.json',
    });
    // A custom model provider otherwise hides websearch even when inference succeeds.
    expect(spec.spawnOptions.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    });
    expect(JSON.parse(spec.spawnOptions.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      instructions: ['/work/project/AGENTS.md'],
      websearch: { provider: 'exa' },
      permissions: [
        { action: 'external_directory', resource: '*', effect: 'ask' },
        { action: 'external_directory', resource: '/knowledge/**', effect: 'allow' },
      ],
      policies: [
        { action: 'integration.use', resource: 'plugin:*', effect: 'deny' },
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'verity', effect: 'allow' },
      ],
    });
    expect(spec.spawnOptions.env).not.toHaveProperty('OPENCODE_CONFIG_DIR');
    expect(spec.spawnOptions.env).not.toHaveProperty('EXA_API_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spec.spawnOptions.env).not.toHaveProperty('DOPPLER_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    // Claude's and Codex's per-command env belong to those commands alone.
    expect(spec.spawnOptions.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(spec.spawnOptions.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(spec.spawnOptions.env).not.toHaveProperty('CODEX_PATH');
    expect(spec.spawnOptions.env).not.toHaveProperty('INITIAL_AGENT_MODE');
  });

  it('keeps project instructions out of isolated OpenCode knowledge turns', () => {
    const spec = agentLaunchSpec(
      {
        command: 'opencode-acp',
        args: [],
        cwd: '/work/project',
        knowledgeIsolation: true,
        knowledgeHome: '/run/verity/isolated-home',
      },
      {
        agentUid: 1000,
        agentGid: 1000,
        env: { OPENCODE_CONFIG_CONTENT: '{"instructions":["/work/project/AGENTS.md"]}' },
      },
    );
    // A Wiki turn must not import instructions from the project it cannot access.
    expect(JSON.parse(spec.spawnOptions.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      instructions: [],
      policies: [
        { action: 'integration.use', resource: 'plugin:*', effect: 'deny' },
        { action: 'provider.use', resource: '*', effect: 'deny' },
        { action: 'provider.use', resource: 'verity', effect: 'allow' },
      ],
    });
    expect(spec.spawnOptions.env).toMatchObject({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    });
  });

  it('leaves the home-mode image on the HOME fallback OpenCode resolves itself', () => {
    // The forward above is the devcontainer half. On a Verity base image the
    // provisioner uses `home` path mode and sets no `XDG_CONFIG_HOME`, leaving
    // OpenCode's writable files under its `$HOME/.config` fallback while the
    // server-owned provider config has its own read-only path. That only works because
    // the broker pins `HOME` to `/home/dev` rather than to the per-turn runtime
    // directory — pointing it at the latter would start every OpenCode turn on
    // those images with no provider configured, and the failure would surface as a
    // model error on the first prompt rather than as a missing mount.
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      {
        agentUid: 1000,
        agentGid: 1000,
        connectorUrl: 'http://127.0.0.1:47821',
        env: {
          PATH: '/usr/bin',
          OPENCODE_CONFIG: '/run/verity/opencode-config/opencode.json',
        },
      },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      HOME: '/home/dev',
      OPENCODE_CONFIG: '/run/verity/opencode-config/opencode.json',
    });
    // Not invented when the container has none: an XDG root the image never set
    // would point the child at a directory nothing mounts.
    expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CONFIG_HOME');
  });

  it('gives OpenCode a writable home for the state it keeps outside its config', async () => {
    // Config is only one of the four XDG roots opencode 1.18.21 uses: session
    // storage and logs go to `$XDG_DATA_HOME/opencode`, locks to
    // `$XDG_STATE_HOME/opencode`, downloaded helper binaries to
    // `$XDG_CACHE_HOME/opencode`. The container sets none of those, so all three
    // fall back to `$HOME` — pinned to `/home/dev`, which a project's own
    // devcontainer image generally does not have. Measured: the child then dies at
    // spawn with `EACCES … mkdir '/home/dev'` before answering `initialize`, so it
    // is every OpenCode turn on those images, not a degraded one. Pinned rather
    // than copied, because there is nothing in the container to copy.
    const spec = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: '/work/project' },
      { agentUid: 1000, agentGid: 1000, env: { XDG_CONFIG_HOME: '/run/verity/xdg' } },
    );
    expect(spec.spawnOptions.env).toMatchObject({
      XDG_DATA_HOME: '/run/verity/opencode/data',
      XDG_STATE_HOME: '/run/verity/opencode/state',
      XDG_CACHE_HOME: '/run/verity/opencode/cache',
    });
    // Handed to the agent by the same pass that prepares Claude's and Codex's
    // directories. The owner of `/run/verity` differs by image — root on some, the
    // agent (uid 1000) on a project sandbox whose ownership pass shipped it to the
    // remote user. Because this supervisor holds CAP_CHOWN but not CAP_DAC_OVERRIDE,
    // root cannot create the directory when the agent owns the parent, so the launcher
    // must create it as whoever owns `/run/verity`. A blind root `mkdir` there died
    // with EACCES and took the whole Runner supervisor down on those images.
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    expect(launcher).toContain('OPENCODE_STATE_DIR=/run/verity/opencode');
    expect(launcher).toContain('OPENCODE_USER_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"');
    // Create as the agent when it owns /run/verity, else as root — never a blind
    // root mkdir that assumes CAP_DAC_OVERRIDE.
    expect(launcher).toMatch(/stat -c '%u' \/run\/verity/);
    expect(launcher).toMatch(/as_agent mkdir -p "\$OPENCODE_STATE_DIR"/);
    expect(launcher).toMatch(/chown "\$AGENT_UID:\$AGENT_GID" "\$OPENCODE_STATE_DIR"/);
    // Deliberately NOT under the runner runtime: that directory outlives the
    // container, and `session-artifacts.ts` names no OpenCode files to delete on
    // the basis that this storage does not.
    expect(launcher).not.toContain('$RUNTIME_DIR/opencode');
  });

  it('keeps every XDG root to the one command that reads them', () => {
    // A shared config root reaching every agent would widen what a compromised one
    // can read, and only opencode-acp has a config there in the first place. The
    // state roots are pinned for it alone for the same reason — Claude and Codex
    // have their own directory variables and no business in OpenCode's.
    for (const command of ['claude-agent-acp', 'codex-acp'] as const) {
      const spec = agentLaunchSpec(
        { command, args: [], cwd: '/work/project' },
        {
          agentUid: 1000,
          agentGid: 1000,
          connectorUrl: 'http://127.0.0.1:47821',
          env: { XDG_CONFIG_HOME: '/run/verity/xdg' },
        },
      );
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CONFIG_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_DATA_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_STATE_HOME');
      expect(spec.spawnOptions.env).not.toHaveProperty('XDG_CACHE_HOME');
    }
  });

  it('starts the broker with the container environment it forwards XDG_CONFIG_HOME from', async () => {
    // The two tests above inject `env` directly, which proves the forward but not
    // that production has anything to forward. That chain is: the provisioner puts
    // `XDG_CONFIG_HOME` in the container `Env` (provisioner.ts, neutral path mode),
    // and the stack launcher starts the broker as an ordinary child so it inherits
    // it. The egress connector next to it is deliberately started under an `env -i`
    // allowlist; the broker under the same treatment would silently drop the
    // variable and leave every OpenCode turn without a provider. Assert the
    // difference rather than trusting a comment to survive the next edit.
    const launcher = await readFile(
      'features/verity-sandbox-toolkit/bin/verity-runner-stack-start',
      'utf8',
    );
    const brokerStart = launcher
      .split('\n')
      .find((line) => line.includes('nohup') && line.includes('verity-agent-spawn-broker'));
    expect(brokerStart).toBeDefined();
    expect(brokerStart).not.toContain('env -i');
  });
});
