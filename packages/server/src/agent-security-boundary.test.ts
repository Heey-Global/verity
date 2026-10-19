import { nodeSpawner } from '@verity/session';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  agentLaunchSpec,
  materializeManagedAgentHome,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

// Records ownership hand-offs: rootless, the agent identity is this process, so
// the resulting owner alone cannot show which identity a file was given to.
const handedOver: { path: string; uid: number; gid: number }[] = [];
beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const original: FileHandle['chown'] = Reflect.get(prototype, 'chown');
  vi.spyOn(prototype, 'chown').mockImplementation(async function (
    this: FileHandle,
    uid: number,
    gid: number,
  ) {
    handedOver.push({ path: await readlink(`/proc/self/fd/${String(this.fd)}`), uid, gid });
    return await original.call(this, uid, gid);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

const commands = ['claude-agent-acp', 'codex-acp', 'opencode-acp'] as const;
let root: string;
beforeEach(async () => {
  handedOver.length = 0;
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
    const isolated = await (async () => {
      const previous = process.umask(0o077);
      try {
        return await materializeManagedAgentHome({ command }, options, 'http://127.0.0.1:12345');
      } finally {
        process.umask(previous);
      }
    })();
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
      for (const name of [
        '.gitconfig',
        'config/git-ignore',
        '.claude.json',
        'config/opencode/.gitignore',
      ])
        expect((await stat(join(isolated.home, name))).mode & 0o777).toBe(0o644);
      expect((await stat(join(isolated.home, 'config/opencode'))).mode & 0o777).toBe(0o755);
      // Codex 0.163 exits with EACCES at startup unless it can open its installation
      // id read-write, so a broker-owned copy crashed every Codex turn.
      const installationId = join(isolated.home, 'codex', 'installation_id');
      expect(handedOver).toContainEqual({
        path: await realpath(installationId),
        uid: options.agentUid,
        gid: options.agentGid,
      });
      expect((await stat(installationId)).mode & 0o777).toBe(0o600);

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

it('retains Codex rollout and SQLite storage across normal and planning homes', async () => {
  for (const directory of ['codex-sessions', 'codex-state/thread-writer-locks'])
    await mkdir(join(root, directory), { recursive: true });
  const options = {
    enforceRoot: false,
    agentUid: process.getuid!(),
    agentGid: process.getgid!(),
    runtimeDir: root,
  };
  for (const planning of [false, true, false]) {
    const isolated = await materializeManagedAgentHome(
      { command: 'codex-acp', planning },
      options,
      'http://127.0.0.1:1',
    );
    try {
      const session = join(isolated.home, 'codex/sessions/rollout.jsonl');
      if (!planning && !(await readFile(session, 'utf8').catch(() => '')))
        await writeFile(session, 'normal');
      const spec = agentLaunchSpec(
        {
          command: 'codex-acp',
          args: [],
          cwd: root,
          planning,
          ...(planning ? { knowledgeHome: isolated.home } : { managedHome: isolated.home }),
        },
        {
          ...options,
          scriptSandboxPath: resolve(
            `features/verity-sandbox-toolkit/prebuilt/linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}/verity-script-sandbox`,
          ),
        },
      );
      if (planning) {
        expect(spec.args).toContain('--runtime-root');
        const confined = spec.args.slice(7, -1);
        const result = spawnSync(
          confined[0]!,
          [...confined.slice(1), '/bin/sh', '-c', 'cat "$1"; echo planning > "$1"', 'sh', session],
          { encoding: 'utf8', timeout: 10000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('normal');
      }
      expect(await readFile(join(isolated.home, 'codex/config.toml'), 'utf8')).toContain(
        JSON.stringify(join(root, 'codex-state')),
      );
    } finally {
      await isolated.cleanup();
    }
  }
  expect(await readFile(join(root, 'codex-sessions/rollout.jsonl'), 'utf8')).toBe('planning\n');
});

it('rejects a symlink supplied as persistent planning runtime storage', async () => {
  const target = join(root, 'target');
  const link = join(root, 'runtime-link');
  await mkdir(target);
  await symlink(target, link);
  const result = spawnSync(
    resolve(
      `features/verity-sandbox-toolkit/prebuilt/linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}/verity-script-sandbox`,
    ),
    [
      '--root',
      root,
      '--cwd',
      root,
      '--loading',
      'dynamic',
      '--dynamic-root',
      target,
      '--read-only-root',
      '--runtime-root',
      link,
      '--',
      '/bin/true',
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  expect(result.status).toBe(126);
  expect(result.stderr).toContain('invalid runtime root');
});

it('cleans managed policy and private runtime directories without following symlinks', async () => {
  const isolated = await materializeManagedAgentHome(
    { command: 'codex-acp' },
    {
      enforceRoot: false,
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
      runtimeDir: root,
    },
    'http://127.0.0.1:1',
  );
  const outside = join(root, 'preserved');
  await writeFile(outside, 'preserve');
  await symlink(outside, join(isolated.home, 'state', 'link'));
  await chmod(join(isolated.home, 'state'), 0);
  await isolated.cleanup();
  await expect(stat(isolated.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(outside, 'utf8')).toBe('preserve');
});
