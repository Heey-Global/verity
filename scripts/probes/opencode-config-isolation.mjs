/**
 * Exercise configuration discovery in the pinned OpenCode executable without
 * model requests, credentials, MCP processes, or network listeners.
 * Run: node scripts/probes/opencode-config-isolation.mjs [opencode executable]
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentLaunchSpec,
  materializeManagedAgentHome,
} from '../../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

const pin = JSON.parse(
  await readFile(
    new URL('../../features/verity-sandbox-toolkit/npm/opencode/package.json', import.meta.url),
    'utf8',
  ),
).dependencies['opencode-ai'];
const executable = process.argv[2] ?? 'opencode';
const root = await mkdtemp(join(tmpdir(), 'verity-opencode-config-'));
try {
  const project = join(root, 'project');
  const home = join(root, 'home');
  const config = join(root, 'config');
  const marker = join(root, 'plugin-loaded');
  const trustedConfig = join(root, 'managed.json');
  for (const directory of [
    project,
    home,
    join(config, 'opencode'),
    join(project, '.opencode', 'agents'),
    join(project, '.opencode', 'plugins'),
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(config, 'opencode', '.gitignore'), '*\n');
  await writeFile(join(project, 'AGENTS.md'), 'Harmless repository instruction probe.\n');
  await writeFile(
    trustedConfig,
    JSON.stringify({
      provider: {
        verity: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Managed probe',
          options: {
            baseURL: 'http://127.0.0.1:1/managed',
            apiKey: 'verity-opencode-gateway-placeholder-v1',
          },
          models: { 'probe-model': { name: 'Probe model' } },
        },
      },
      agent: { plan: { permission: { edit: 'deny' } } },
    }),
  );
  await writeFile(
    join(project, 'opencode.json'),
    JSON.stringify({
      provider: {
        verity: { options: { baseURL: 'http://127.0.0.1:1/overridden' } },
        'project-probe': {
          name: 'Project probe',
          options: { baseURL: 'http://127.0.0.1:1/project' },
        },
      },
      mcp: { 'project-probe': { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false } },
      agent: { plan: { permission: { edit: 'allow' } } },
    }),
  );
  await writeFile(
    join(project, '.opencode', 'opencode.json'),
    JSON.stringify({
      provider: { 'directory-probe': { name: 'Directory probe' } },
      mcp: { 'directory-probe': { type: 'remote', url: 'http://127.0.0.1:1/mcp', enabled: false } },
    }),
  );
  await writeFile(
    join(project, '.opencode', 'agents', 'project-probe.md'),
    '---\ndescription: Harmless discovery probe\nmode: subagent\n---\nProbe only.\n',
  );
  await writeFile(
    join(project, '.opencode', 'plugins', 'project-probe.js'),
    `import { writeFileSync } from 'node:fs';\nexport const Probe = async () => { writeFileSync(${JSON.stringify(marker)}, 'loaded'); return {}; };\n`,
  );

  const isolatedEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG: trustedConfig,
  };
  const version = spawnSync(executable, ['--version'], {
    env: isolatedEnv,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(version.stdout.trim(), pin);

  async function openSession(extra, confined) {
    const argv = confined?.args.slice(7);
    const child = spawn(argv?.[0] ?? executable, argv ? argv.slice(1) : ['acp'], {
      cwd: project,
      env: { ...isolatedEnv, ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`ACP timeout: ${errors}`)), 120_000);
        const fail = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.once('error', fail);
        child.once('exit', (code) => fail(new Error(`ACP exited ${code}: ${errors}`)));
        lines.on('line', (line) => {
          let reply;
          try {
            reply = JSON.parse(line);
          } catch {
            return;
          }
          if (reply.error) return fail(new Error(JSON.stringify(reply.error)));
          if (reply.id === 1) {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'session/new',
                params: { cwd: project, mcpServers: [] },
              }) + '\n',
            );
          }
          if (reply.id === 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {} },
          }) + '\n',
        );
      });
    } finally {
      lines.close();
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
    }
  }

  function resolved(extra) {
    const result = spawnSync(executable, ['debug', 'config'], {
      cwd: project,
      env: { ...isolatedEnv, ...extra },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const start = result.stdout.indexOf('{');
    return JSON.parse(result.stdout.slice(start));
  }

  const launch = agentLaunchSpec(
    { command: 'opencode-acp', args: [], cwd: project },
    { agentUid: 1000, agentGid: 1000, env: {} },
  );
  const brokerFlags = Object.fromEntries(
    ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'OPENCODE_CONFIG_CONTENT'].map((key) => [
      key,
      launch.spawnOptions.env[key],
    ]),
  );
  const baseline = resolved({});
  assert.ok(baseline.provider?.['project-probe']);
  assert.equal(baseline.provider?.verity?.options?.baseURL, 'http://127.0.0.1:1/overridden');
  assert.ok(baseline.provider?.['directory-probe']);
  assert.ok(baseline.mcp?.['directory-probe']);
  assert.ok(baseline.mcp?.['project-probe']);
  assert.equal(baseline.agent?.plan?.permission?.edit, 'allow');
  assert.ok(baseline.agent?.['project-probe']);
  assert.ok(baseline.plugin?.some((entry) => JSON.stringify(entry).includes('project-probe')));
  await rm(marker, { force: true });
  const hardened = resolved(brokerFlags);
  assert.deepEqual(hardened.instructions, [join(project, 'AGENTS.md')]);
  assert.equal(hardened.provider?.['project-probe'], undefined);
  assert.equal(hardened.provider?.verity?.options?.baseURL, 'http://127.0.0.1:1/managed');
  assert.ok(hardened.provider?.verity?.models?.['probe-model']);
  assert.equal(hardened.provider?.['directory-probe'], undefined);
  assert.equal(hardened.mcp?.['directory-probe'], undefined);
  assert.equal(hardened.mcp?.['project-probe'], undefined);
  assert.equal(hardened.agent?.plan?.permission?.edit, 'deny');
  assert.equal(hardened.agent?.['project-probe'], undefined);
  assert.equal(
    hardened.plugin?.some((entry) => JSON.stringify(entry).includes('project-probe')),
    false,
  );
  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);

  // These flags do not make writable global configuration trustworthy.
  await writeFile(
    join(config, 'opencode', 'opencode.json'),
    JSON.stringify({ provider: { 'global-probe': { name: 'Global probe' } } }),
  );
  const global = resolved(brokerFlags);
  assert.ok(global.provider?.['global-probe']);
  await mkdir(join(config, 'opencode', 'plugins'), { recursive: true });
  await writeFile(
    join(config, 'opencode', 'plugins', 'global-probe.js'),
    `import { writeFileSync } from 'node:fs';\nexport const Probe = async () => { writeFileSync(${JSON.stringify(marker)}, 'loaded'); return {}; };\n`,
  );
  await openSession({ ...brokerFlags, OPENCODE_PURE: '0' });
  assert.equal(await readFile(marker, 'utf8'), 'loaded');
  await rm(marker);
  await openSession(brokerFlags);
  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
  console.log(
    'PASS: ACP session initialization loads a canary plugin only when pure mode is disabled.',
  );
  console.log('PASS: project provider, MCP, plan, agent and plugin discovery are isolated.');
  const options = {
    enforceRoot: false,
    agentUid: process.getuid(),
    agentGid: process.getgid(),
    runtimeDir: root,
    env: { ...isolatedEnv },
  };
  const managed = await materializeManagedAgentHome(
    { command: 'opencode-acp' },
    options,
    'http://127.0.0.1:1',
  );
  try {
    const launch = agentLaunchSpec(
      { command: 'opencode-acp', args: [], cwd: project, managedHome: managed.home },
      options,
    );
    const env = {
      ...launch.spawnOptions.env,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      XDG_DATA_HOME: join(root, 'managed-data'),
      XDG_STATE_HOME: join(root, 'managed-state'),
      XDG_CACHE_HOME: join(root, 'managed-cache'),
    };
    const actual = resolved(env);
    assert.equal(actual.provider?.['global-probe'], undefined);
    assert.equal(actual.provider?.['project-probe'], undefined);
    assert.equal(actual.provider?.verity.options.baseURL, 'http://127.0.0.1:1/opencode');
    await openSession(env);
    assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
    console.log(
      'PASS: managed HOME/XDG excludes poisoned global settings, agents, tools and plugins.',
    );
  } finally {
    await managed.cleanup();
  }
  const planHome = await materializeManagedAgentHome(
    { command: 'opencode-acp', planning: true },
    options,
    'http://127.0.0.1:1',
  );
  try {
    const launch = agentLaunchSpec(
      {
        command: 'opencode-acp',
        args: [],
        cwd: project,
        planning: true,
        knowledgeHome: planHome.home,
      },
      {
        ...options,
        scriptSandboxPath: resolve(
          `features/verity-sandbox-toolkit/prebuilt/linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}/verity-script-sandbox`,
        ),
      },
    );
    await openSession(
      {
        ...launch.spawnOptions.env,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
      },
      launch,
    );
    console.log('PASS: OpenCode ACP starts inside the shared planning filesystem boundary.');
  } finally {
    await planHome.cleanup();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
