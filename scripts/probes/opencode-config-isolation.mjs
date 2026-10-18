/**
 * Exercise configuration discovery in the pinned OpenCode executable without
 * upstream model requests, credentials, or external MCP processes. V2 uses a private loopback server.
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
).dependencies['@opencode/cli'];
const executableName = process.argv[2] ?? 'opencode';
const executableLookup = spawnSync('which', [executableName], { encoding: 'utf8' });
assert.equal(executableLookup.status, 0, 'OpenCode executable must resolve');
const executable = executableLookup.stdout.trim();
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
          npm: '@opencode/ai/providers/openai-compatible',
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
    '---\ndescription: Harmless discovery probe\nmode: primary\n---\nProbe only.\n',
  );
  await writeFile(
    join(project, '.opencode', 'plugins', 'project-probe.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default { id: 'verity.probe', setup: async () => {} };\n`,
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
  assert.equal(version.stdout.trim(), `opencode v${pin}`);

  async function openSession(extra, confined) {
    const argv = confined?.args.slice(7);
    const child = spawn(
      argv?.[0] ?? executable,
      argv ? [...argv.slice(1, -1), executable, 'acp'] : ['acp'],
      {
        cwd: project,
        env: { ...isolatedEnv, ...extra },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = new Promise((done) => child.once('close', done));
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const lines = createInterface({ input: child.stdout });
    try {
      return await new Promise((resolve, reject) => {
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
            resolve(reply.result);
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
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed;
      clearTimeout(timer);
    }
  }

  function resolved(extra) {
    // V2 debug commands otherwise reuse a background server with stale config.
    const disable = spawnSync(executable, ['service', 'set', 'disabled', 'true'], {
      env: { ...isolatedEnv, ...extra },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(disable.status, 0, disable.stderr);
    const result = spawnSync(executable, ['debug', 'config'], {
      cwd: project,
      env: { ...isolatedEnv, ...extra },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const entries = JSON.parse(result.stdout);
    assert.ok(Array.isArray(entries), 'V2 debug config must return configuration entries');
    const merge = (left, right) => {
      for (const [key, value] of Object.entries(right)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          left[key] = merge(left[key] ?? {}, value);
        } else if (Array.isArray(value)) {
          left[key] = [...(left[key] ?? []), ...value];
        } else left[key] = value;
      }
      return left;
    };
    return entries.reduce((config, entry) => merge(config, entry.info ?? {}), {});
  }

  const launch = agentLaunchSpec(
    { command: 'opencode-acp', args: [], cwd: project },
    { agentUid: 1000, agentGid: 1000, env: {} },
  );
  const brokerFlags = Object.fromEntries(
    ['OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG_CONTENT'].map((key) => [
      key,
      launch.spawnOptions.env[key],
    ]),
  );
  const baseline = resolved({});
  assert.ok(baseline.providers?.['project-probe']);
  assert.equal(baseline.providers?.verity?.settings?.baseURL, 'http://127.0.0.1:1/overridden');
  assert.ok(baseline.providers?.['directory-probe']);
  assert.ok(baseline.mcp?.servers?.['directory-probe']);
  assert.ok(baseline.mcp?.servers?.['project-probe']);
  assert.ok(
    baseline.agents?.plan?.permissions?.some(
      (rule) => rule.action === 'edit' && rule.effect === 'allow',
    ),
  );
  const baselineSession = await openSession({});
  assert.ok(
    baselineSession.configOptions
      .find((option) => option.id === 'mode')
      .options.some((option) => option.value === 'project-probe'),
  );
  assert.equal(await readFile(marker, 'utf8'), 'loaded');

  await rm(marker, { force: true });
  const hardened = resolved(brokerFlags);
  const hardenedSession = await openSession(brokerFlags);
  assert.deepEqual(
    hardenedSession.configOptions
      .find((option) => option.id === 'model')
      .options.map((option) => option.value),
    ['verity/probe-model'],
  );
  assert.equal(
    hardenedSession.configOptions
      .find((option) => option.id === 'mode')
      .options.some((option) => option.value === 'project-probe'),
    false,
  );
  assert.deepEqual(hardened.instructions, [join(project, 'AGENTS.md')]);
  assert.equal(hardened.providers?.['project-probe'], undefined);
  assert.equal(hardened.providers?.verity?.settings?.baseURL, 'http://127.0.0.1:1/managed');
  assert.ok(hardened.providers?.verity?.models?.['probe-model']);
  assert.equal(hardened.providers?.['directory-probe'], undefined);
  assert.equal(hardened.mcp?.servers?.['directory-probe'], undefined);
  assert.equal(hardened.mcp?.servers?.['project-probe'], undefined);
  assert.ok(
    hardened.agents?.plan?.permissions?.some(
      (rule) => rule.action === 'edit' && rule.effect === 'deny',
    ),
  );
  assert.equal(hardened.agents?.['project-probe'], undefined);

  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);

  // These flags do not make writable global configuration trustworthy.
  await writeFile(
    join(config, 'opencode', 'opencode.json'),
    JSON.stringify({ provider: { 'global-probe': { name: 'Global probe' } } }),
  );
  const global = resolved(brokerFlags);
  assert.ok(global.providers?.['global-probe']);
  await mkdir(join(config, 'opencode', 'plugins'), { recursive: true });
  await writeFile(
    join(config, 'opencode', 'plugins', 'global-probe.js'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'loaded');\nexport default { id: 'verity.probe', setup: async () => {} };\n`,
  );
  await openSession({ ...brokerFlags, OPENCODE_CONFIG_CONTENT: '{}' });
  assert.equal(await readFile(marker, 'utf8'), 'loaded');
  await rm(marker);
  await openSession(brokerFlags);
  assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
  console.log(
    'PASS: ACP session initialization loads a canary plugin only when the plugin policy is removed.',
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
    assert.equal(actual.providers?.['global-probe'], undefined);
    assert.equal(actual.providers?.['project-probe'], undefined);
    assert.equal(actual.providers?.verity.settings.baseURL, 'http://127.0.0.1:1/opencode');
    await openSession(env);
    assert.equal(await readFile(marker, 'utf8').catch(() => undefined), undefined);
    console.log(
      'PASS: managed HOME/XDG excludes poisoned global settings, agents, tools and plugins.',
    );
  } finally {
    await managed.cleanup();
  }
  await mkdir(join(root, 'opencode-state'), { recursive: true });
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
    const writeProbe = spawnSync(
      launch.args[7],
      [
        ...launch.args.slice(8, -1),
        '/bin/sh',
        '-c',
        `echo runtime > "$1/write-canary"; /bin/sh -c 'echo modified > "$1/AGENTS.md"' sh "$2"`,
        'sh',
        join(root, 'opencode-state'),
        project,
      ],
      { ...launch.spawnOptions, encoding: 'utf8', timeout: 10_000 },
    );
    assert.notEqual(writeProbe.status, 0, writeProbe.stderr);
    assert.equal(await readFile(join(root, 'opencode-state', 'write-canary'), 'utf8'), 'runtime\n');
    assert.equal(
      await readFile(join(project, 'AGENTS.md'), 'utf8'),
      'Harmless repository instruction probe.\n',
    );
    await openSession(
      {
        ...launch.spawnOptions.env,
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        XDG_DATA_HOME: join(root, 'opencode-state', 'data'),
        XDG_STATE_HOME: join(root, 'opencode-state', 'state'),
        XDG_CACHE_HOME: join(root, 'opencode-state', 'cache'),
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
