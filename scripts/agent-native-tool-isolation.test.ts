import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, it } from 'vitest';
import { materializeManagedAgentHome } from '../features/verity-sandbox-toolkit/bin/verity-agent-spawn-broker.mjs';

type ModelRequest = {
  tools?: { name?: string; type?: string; function?: { name?: string } }[];
  messages?: unknown[];
};

function assertCodexInventory(request: ModelRequest): void {
  const names = (request.tools ?? []).map((tool) => tool.name ?? tool.type);
  expect(names).toContain('mcp__verity');
  expect(
    names.filter(
      (name) =>
        ![
          'mcp__verity',
          'list_mcp_resources',
          'list_mcp_resource_templates',
          'read_mcp_resource',
        ].includes(name!),
    ),
  ).toEqual([]);
}

/** Exercise the installed executables: configuration fields alone cannot prove their tool semantics. */
async function probe(command: 'codex' | 'opencode', mutatePatch = false, allowSkill = false) {
  const directory = await mkdtemp(join(tmpdir(), 'native-tools-'));
  const requests: ModelRequest[] = [];
  let mcpCalls = 0;
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url === '/mcp') {
      const mcp = new McpServer({ name: 'verity', version: '1' });
      mcp.tool('verity_probe', 'Tool isolation test', async () => {
        mcpCalls += 1;
        return { content: [{ type: 'text', text: 'Verity tool executed' }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      let body = '';
      for await (const chunk of request) body += String(chunk);
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as ModelRequest;
    // OpenCode also asks the model to name the session without any agent tools.
    if ((parsed.tools?.length ?? 0) === 0) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'No title required', type: 'invalid_request_error' } }),
      );
      return;
    }
    requests.push(parsed);
    if (command === 'opencode' && requests.length < 3) {
      // First prove that the gateway survives, then try the residual native tool.
      const name = requests.length === 1 ? 'verity_verity_probe' : 'skill';
      const args = requests.length === 1 ? '{}' : '{"id":"private"}';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      response.end(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: 'function',
                function: { name, arguments: args },
              },
            ],
          },
          null,
        ) +
          chunk({}, 'tool_calls') +
          'data: [DONE]\n\n',
      );
      return;
    }
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { message: 'Tool inventory recorded', type: 'invalid_request_error' },
      }),
    );
  };
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      response.writeHead(500);
      response.end('Test endpoint failed');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No test endpoint');
  const endpoint = `http://127.0.0.1:${address.port}`;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    // The managed runtime creates these legacy storage targets before launching agents.
    await mkdir(join(directory, 'codex-sessions'), { recursive: true });
    await mkdir(join(directory, 'codex-state', 'thread-writer-locks'), { recursive: true });
    const source = join(directory, 'models.json');
    await writeFile(source, JSON.stringify({ provider: { verity: { models: { probe: {} } } } }));
    const isolated = await materializeManagedAgentHome(
      {
        command: command === 'codex' ? 'codex-acp' : 'opencode-acp',
        gatewayToolsOnly: true,
        gatewayToolsModel: 'codex/gpt-6.1',
      },
      {
        runtimeDir: directory,
        enforceRoot: false,
        agentUid: process.getuid!(),
        agentGid: process.getgid!(),
        env: { OPENCODE_CONFIG: source },
      },
      endpoint,
    );
    cleanup = () => isolated.cleanup();
    const home = isolated.home;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      TMPDIR: join(home, 'tmp'),
      VERITY_CODEX_PLACEHOLDER: 'test-placeholder',
      OPENCODE_CONFIG: join(home, 'config', 'opencode.json'),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    };
    let args: string[];
    if (command === 'codex') {
      const config = join(home, 'codex', 'config.toml');
      await writeFile(
        config,
        (await readFile(config, 'utf8')) + `\n[mcp_servers.verity]\nurl = "${endpoint}/mcp"\n`,
      );
      if (mutatePatch) {
        const path = join(home, 'codex', 'restricted-models.json');
        const catalog = JSON.parse(await readFile(path, 'utf8')) as {
          models: { apply_patch_tool_type: string | null }[];
        };
        catalog.models[0]!.apply_patch_tool_type = 'freeform';
        await writeFile(path, JSON.stringify(catalog));
      }
      args = ['exec', '--skip-git-repo-check', '-C', directory, 'Inventory test'];
    } else {
      const path = env.OPENCODE_CONFIG!;
      const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      config['model'] = 'verity/probe';
      config['mcp'] = { verity: { type: 'remote', url: `${endpoint}/mcp` } };
      config['skills'] = [join(home, 'config', 'opencode', 'skills')];
      if (allowSkill) {
        (config['policies'] as unknown[]).push(
          { action: 'skill.use', resource: '*', effect: 'allow' },
          { action: 'tool.use', resource: 'skill:*', effect: 'allow' },
        );
        (config['permissions'] as unknown[]).push({
          action: 'skill',
          resource: '*',
          effect: 'allow',
        });
      }
      await writeFile(path, JSON.stringify(config));
      const skill = join(home, 'config', 'opencode', 'skills', 'private');
      await mkdir(skill, { recursive: true });
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: private\ndescription: Private test skill\n---\nNATIVE_SKILL_MUST_NOT_REACH_THE_MODEL\n',
      );
      args = ['run', '--standalone', '-m', 'verity/probe', 'Inventory test'];
    }
    const child = spawn(command, args, {
      cwd: resolve('.'),
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-5000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    }).finally(() => clearTimeout(timer));
    expect(code, stderr).toBe(1);
    expect(requests.length, stderr).toBeGreaterThan(0);
    return { requests, mcpCalls };
  } finally {
    await cleanup?.();
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

const hasCodex = spawnSync('codex', ['--version'], { timeout: 5000 }).status === 0;
const hasOpenCode = spawnSync('opencode', ['--version'], { timeout: 5000 }).status === 0;

it.skipIf(!hasCodex)(
  'installed Codex exposes only the Verity gateway and its resource readers',
  async () => {
    const { requests } = await probe('codex');
    assertCodexInventory(requests[0]!);
  },
  35_000,
);

it.skipIf(!hasCodex)(
  'the inventory guard rejects model metadata that restores apply_patch',
  async () => {
    const { requests } = await probe('codex', true);
    expect((requests[0]!.tools ?? []).some((tool) => tool.name === 'apply_patch')).toBe(true);
    expect(() => assertCodexInventory(requests[0]!)).toThrow();
  },
  35_000,
);

it.skipIf(!hasOpenCode)(
  'installed OpenCode executes Verity MCP but refuses the residual skill tool',
  async () => {
    const { requests, mcpCalls } = await probe('opencode');
    expect(requests[0]!.tools?.map((tool) => tool.function?.name).sort()).toEqual([
      'skill',
      'verity_verity_probe',
    ]);
    expect(mcpCalls).toBe(1);
    expect(requests).toHaveLength(3);
    const history = JSON.stringify(requests[2]!.messages);
    expect(history).not.toContain('NATIVE_SKILL_MUST_NOT_REACH_THE_MODEL');
    expect(history).toContain('Unable to load skill private');
    // Prove the same fixture is readable when its actual restrictions are removed.
    const control = await probe('opencode', false, true);
    expect(JSON.stringify(control.requests[2]!.messages)).toContain(
      'NATIVE_SKILL_MUST_NOT_REACH_THE_MODEL',
    );
  },
  35_000,
);
