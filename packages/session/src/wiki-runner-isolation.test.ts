import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import {
  agentLaunchSpec,
  materializeKnowledgeIsolation,
} from '../../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';
import {
  handleSupervisorRequest,
  validateStartTurnRequest,
} from '../../../features/verity-sandbox-toolkit/bin/verity-runner-supervisor.mjs';
import { assertBrokerKnowledgeIsolation } from './broker-spawner.js';
const execFileAsync = promisify(execFile);
it.each(['claude-agent-acp', 'codex-acp', 'opencode-acp'] as const)(
  'isolates %s reads and homes without inheriting Docker access',
  (command) => {
    const spec = agentLaunchSpec(
      {
        command,
        args: [],
        cwd: '/work/job',
        knowledgeIsolation: true,
        knowledgeHome: '/run/verity-knowledge/job',
      },
      {
        agentUid: 1000,
        agentGid: 1000,
        dockerGid: '999',
        env: { CODEX_HOME: '/shared/codex', CLAUDE_CONFIG_DIR: '/shared/claude', HOME: '/shared' },
      },
    );
    expect(spec.args).toContain('/usr/local/bin/verity-script-sandbox');
    expect(spec.args).toContain('--write-isolated');
    expect(spec.args).toContain('--clear-groups');
    expect(spec.args).not.toContain('--groups=999');
    expect(spec.spawnOptions.env).toMatchObject({
      HOME: '/run/verity-knowledge/job',
      CODEX_HOME: '/run/verity-knowledge/job/codex',
      CLAUDE_CONFIG_DIR: '/run/verity-knowledge/job/claude',
    });
    expect(JSON.stringify(spec.spawnOptions.env)).not.toContain('/shared');
  },
);
it('refuses isolation when the broker has not prepared a new home', () => {
  expect(() =>
    agentLaunchSpec(
      { command: 'codex-acp', args: [], cwd: '/work/job', knowledgeIsolation: true },
      { agentUid: 1000, agentGid: 1000 },
    ),
  ).toThrow('home was not prepared');
});
it('older brokers fail closed before an agent can be spawned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-old-broker-'));
  const server = createServer((socket) => {
    socket.once('data', () => socket.end(JSON.stringify({ ok: true, protocolVersion: 1 }) + '\n'));
  });
  try {
    await new Promise<void>((resolve) => server.listen(join(directory, 'broker.sock'), resolve));
    await expect(assertBrokerKnowledgeIsolation(join(directory, 'broker.sock'))).rejects.toThrow(
      'does not support',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
it('supervisor advertises the mandatory isolation capability', async () => {
  expect(
    await handleSupervisorRequest('/tmp/unused', 'instance', {
      protocolVersion: 1,
      kind: 'status',
    }),
  ).toMatchObject({ knowledgeIsolation: true });
});
it('the shipped kernel helper denies another project while retaining the job directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-landlock-'));
  try {
    const job = join(root, 'job'),
      home = join(root, 'home');
    await mkdir(job);
    await mkdir(home);
    const allowed = join(job, 'source'),
      denied = join(root, 'other-project');
    await writeFile(allowed, 'allowed');
    await writeFile(denied, 'private');
    const helper = resolve(
      `features/verity-sandbox-toolkit/prebuilt/linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}/verity-script-sandbox`,
    );
    const run = (executable: string, args: string[]) => {
      const spec = agentLaunchSpec(
        { command: 'codex-acp', args, cwd: job, knowledgeIsolation: true, knowledgeHome: home },
        { agentUid: 1000, agentGid: 1000, scriptSandboxPath: helper, codexAcpPath: executable },
      );
      // Exercise the exact policy emitted by the broker, not a hand-maintained copy.
      return execFileAsync(helper, spec.args.slice(spec.args.indexOf(helper) + 1));
    };
    expect((await run('/usr/bin/cat', [allowed])).stdout).toBe('allowed');
    await expect(run('/usr/bin/cat', [denied])).rejects.toMatchObject({ code: 1 });
    await expect(
      run('/usr/bin/sh', ['-c', 'printf changed > "$1"', 'wiki', denied]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(run('/usr/bin/rm', [denied])).rejects.toMatchObject({ code: 1 });
    expect(await readFile(denied, 'utf8')).toBe('private');
    await run('/usr/bin/sh', ['-c', 'printf changed > "$1"', 'wiki', allowed]);
    expect(await readFile(allowed, 'utf8')).toBe('changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('materializes only model gateway settings in a fresh OpenCode home and removes it on cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-broker-home-'));
  await chmod(root, 0o770);
  const configPath = join(root, 'opencode.json');
  await writeFile(
    configPath,
    JSON.stringify({
      instructions: ['private-project.md'],
      mcp: { private: {} },
      provider: { verity: { models: { 'test-model': { name: 'test-model' } } } },
    }),
  );
  await writeFile(join(root, 'egress-connector.url'), 'http://127.0.0.1:47821\n');
  const isolated = await materializeKnowledgeIsolation(
    { command: 'opencode-acp' },
    {
      runtimeDir: root,
      enforceRoot: false,
      agentUid: process.getuid!(),
      agentGid: process.getgid!(),
      env: { OPENCODE_CONFIG: configPath },
    },
    'http://127.0.0.1:47821',
  );
  try {
    const config = await readFile(join(isolated.home, 'config', 'opencode.json'), 'utf8');
    expect(config).toContain('test-model');
    expect(config).toContain('verity-opencode-gateway-placeholder-v1');
    expect(config).not.toContain('private-project');
    expect(config).not.toContain('"mcp"');
    expect(isolated.home).toContain('/wiki-homes/job-');
    await isolated.cleanup();
    await expect(readFile(join(isolated.home, 'config', 'opencode.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await isolated.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

it('hands an existing private runtime parent to the actual agent uid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-broker-uid-'));
  const parent = join(root, 'wiki-homes');
  const configPath = join(root, 'opencode.json');
  const canChangeIdentity = process.getuid?.() === 0;
  const agentUid = canChangeIdentity ? 65534 : process.getuid!();
  const agentGid = canChangeIdentity ? 65534 : process.getgid!();
  await chmod(root, 0o711);
  await mkdir(parent, { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({ provider: { verity: { models: {} } } }));
  const isolated = await materializeKnowledgeIsolation(
    { command: 'opencode-acp' },
    {
      runtimeDir: root,
      enforceRoot: false,
      agentUid,
      agentGid,
      env: { OPENCODE_CONFIG: configPath },
    },
    'http://127.0.0.1:47821',
  );
  try {
    expect((await stat(parent)).mode & 0o777).toBe(0o711);
    if (canChangeIdentity)
      await execFileAsync('/usr/bin/setpriv', [
        `--reuid=${String(agentUid)}`,
        `--regid=${String(agentGid)}`,
        '--clear-groups',
        '/usr/bin/test',
        '-r',
        join(isolated.home, 'config', 'opencode.json'),
      ]);
    else await readFile(join(isolated.home, 'config', 'opencode.json'));
    await isolated.cleanup();
    await expect(readFile(isolated.home)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await isolated.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains the trusted isolation flag and rejects inherited context or external tools', () => {
  const request = {
    protocolVersion: 1,
    kind: 'start-turn',
    turnId: 'turn',
    startCommandId: 'start',
    sessionId: 'session',
    backend: 'codex-acp',
    worktree: '/work/job',
    cwd: '/work/job',
    prompt: 'Compile Wiki',
    steerable: false,
    permissionControl: false,
    knowledgeIsolation: true,
  };
  expect(validateStartTurnRequest(request)).toMatchObject({
    knowledgeIsolation: true,
    trustedCliExecution: false,
  });
  for (const unsafe of [
    { resumeSessionId: 'old' },
    { trustedCliExecution: true },
    { mcpProxyToken: 'external' },
    { mcpServers: [{ name: 'external', url: 'https://example.test', headers: [] }] },
  ])
    expect(() => validateStartTurnRequest({ ...request, ...unsafe })).toThrow();
});
