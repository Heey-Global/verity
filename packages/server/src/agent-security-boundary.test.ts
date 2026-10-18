import { nodeSpawner } from '@verity/session';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  agentLaunchSpec,
  materializeManagedAgentHome,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

const commands = ['claude-agent-acp', 'codex-acp', 'opencode-acp'] as const;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verity-agent-security-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each(commands)(
  'separates %s managed policy from poisoned user configuration and runtime data',
  async (command) => {
    const poisoned = join(root, 'poisoned');
    await mkdir(poisoned);
    await writeFile(join(poisoned, 'config.toml'), 'model_provider = "attacker"\n');
    await writeFile(join(poisoned, 'settings.json'), '{"hooks":{"SessionStart":[]}}');
    const config = join(root, 'managed.json');
    await writeFile(config, JSON.stringify({ provider: { verity: { models: { probe: {} } } } }));
    const options = {
      enforceRoot: false,
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
      runtimeDir: root,
      env: {
        HOME: poisoned,
        GIT_USER_NAME: 'Fixture "identity"',
        GIT_USER_EMAIL: 'fixture@example.test',
        CODEX_HOME: poisoned,
        XDG_CONFIG_HOME: poisoned,
        OPENCODE_CONFIG: config,
      },
    };
    const isolated = await materializeManagedAgentHome(
      { command },
      options,
      'http://127.0.0.1:12345',
    );
    try {
      const spec = agentLaunchSpec(
        { command, args: [], cwd: root, managedHome: isolated.home },
        options,
      );
      expect(spec.spawnOptions.env?.HOME).toBe(isolated.home);
      expect(spec.spawnOptions.env?.XDG_CONFIG_HOME).toBe(join(isolated.home, 'config'));
      const identity = spawnSync('git', ['config', '--global', 'user.name'], {
        env: {
          ...process.env,
          HOME: isolated.home,
          XDG_CONFIG_HOME: join(isolated.home, 'config'),
        },
        encoding: 'utf8',
      });
      expect(identity.status).toBe(0);
      expect(identity.stdout.trim()).toBe('Fixture "identity"');
      const codex = await readFile(join(isolated.home, 'codex', 'config.toml'), 'utf8');
      expect(codex).toContain('model_provider = "verity_gateway"');
      expect(codex).not.toContain('attacker');
      expect(codex).not.toContain('trust_level = "trusted"');
      expect(codex).toContain('multi_agent = false');
      for (const path of ['.', 'config', 'codex', 'codex/config.toml', 'claude']) {
        const metadata = await stat(join(isolated.home, path));
        expect(metadata.uid).toBe(process.getuid!());
        // The production broker is root; the child identity cannot replace these files.
        expect(metadata.mode & 0o022).toBe(0);
      }
      expect((await stat(join(isolated.home, 'state'))).mode & 0o700).toBe(0o700);
      expect(await readFile(join(poisoned, 'config.toml'), 'utf8')).toContain('attacker');
    } finally {
      await isolated.cleanup();
    }
  },
);

it.each(commands)('requires a prepared filesystem boundary for %s planning', (command) => {
  expect(() =>
    agentLaunchSpec(
      { command, args: [], cwd: root, planning: true },
      {
        agentUid: 1000,
        agentGid: 1000,
      },
    ),
  ).toThrow('home was not prepared');
  const spec = agentLaunchSpec(
    { command, args: [], cwd: root, planning: true, knowledgeHome: '/run/verity-test-home' },
    {
      agentUid: 1000,
      agentGid: 1000,
      dockerGid: '999',
    },
  );
  expect(spec.args).toContain('--read-only-root');
  expect(spec.args).toContain('--clear-groups');
  expect(spec.args).not.toContain('--groups=999');
});

it('refuses project writes from a shell and its descendants while allowing runtime writes', async () => {
  const project = join(root, 'project');
  const runtime = join(root, 'runtime');
  await mkdir(project);
  await mkdir(runtime);
  await chmod(root, 0o755);
  await writeFile(join(project, 'keep'), 'original');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const helper = resolve(
    `features/verity-sandbox-toolkit/prebuilt/linux-${architecture}/verity-script-sandbox`,
  );
  const run = (extra: string[]) =>
    spawnSync(
      helper,
      [
        '--root',
        project,
        '--cwd',
        project,
        '--loading',
        'dynamic',
        '--dynamic-root',
        runtime,
        ...extra,
        '--',
        '/bin/sh',
        '-c',
        'echo runtime > "$1/state"; /bin/sh -c \'echo modified > "$1/keep"\' sh "$2"',
        'sh',
        runtime,
        project,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
  const protectedRun = run(['--read-only-root']);
  expect(protectedRun.status, protectedRun.stderr).not.toBe(0);
  expect(await readFile(join(project, 'keep'), 'utf8')).toBe('original');
  expect(await readFile(join(runtime, 'state'), 'utf8')).toBe('runtime\n');
  // This control proves a passing refusal is caused by the requested policy.
  const control = run([]);
  expect(control.status, control.stderr).toBe(0);
  expect(await readFile(join(project, 'keep'), 'utf8')).toBe('modified\n');
});

it('refuses a planning turn through the unconfined native spawner', () => {
  expect(() =>
    nodeSpawner('/bin/sh', ['-c', 'exit 0'], { cwd: root, env: {}, planning: true }),
  ).toThrow('Planning requires the isolated agent spawn broker');
});
