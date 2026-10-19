/** Real pinned OpenCode ACP turns and copied V1 storage, using only a loopback model fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline';

const executable = resolve(process.argv[2]);
const previous = process.argv[3] ? resolve(process.argv[3]) : undefined;
const root = await mkdtemp(join(tmpdir(), 'verity-opencode-session-'));
let calls = 0;
let cancellationStarted;
const server = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  assert.equal(request.headers.authorization, 'Bearer verity-fixture-placeholder');
  assert.equal(JSON.parse(input).model, 'probe-model');
  calls += 1;
  if (input.includes('cancel-fixture')) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    cancellationStarted?.();
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = {
    id: `probe-${calls}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'probe-model',
  };
  for (const value of [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: `fixture reply ${calls}` },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ])
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  response.end('data: [DONE]\n\n');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const project = join(root, 'project');
await mkdir(project);
await writeFile(join(project, 'AGENTS.md'), 'Harmless ACP fixture instructions.\n');
const config = join(root, 'managed.json');
await writeFile(
  config,
  JSON.stringify({
    provider: {
      verity: {
        npm: '@opencode/ai/providers/openai-compatible',
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'verity-fixture-placeholder' },
        models: { 'probe-model': { name: 'Probe', limit: { context: 32000, output: 1024 } } },
      },
    },
  }),
);

async function connect(binary, data) {
  const child = spawn(binary, ['acp'], {
    cwd: project,
    env: {
      PATH: process.env.PATH,
      HOME: join(data, 'home'),
      XDG_CONFIG_HOME: join(data, 'config'),
      XDG_DATA_HOME: join(data, 'data'),
      XDG_STATE_HOME: join(data, 'state'),
      XDG_CACHE_HOME: join(data, 'cache'),
      OPENCODE_CONFIG: config,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let serial = 0;
  const pending = new Map();
  const updates = [];
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'session/update') updates.push(message.params.update);
    if (message.id !== undefined && pending.has(message.id)) {
      const { done, fail, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) fail(new Error(JSON.stringify(message.error)));
      else done(message.result);
    }
  });
  const closed = new Promise((done) => child.once('close', done));
  child.once('exit', (code) => {
    for (const { fail, timer } of pending.values()) {
      clearTimeout(timer);
      fail(new Error(`ACP exited ${code}: ${stderr}`));
    }
  });
  const request = (method, params) =>
    new Promise((done, fail) => {
      const id = ++serial;
      const timer = setTimeout(() => fail(new Error(`ACP timeout ${method}: ${stderr}`)), 60_000);
      pending.set(id, { done, fail, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  return {
    request,
    updates,
    notify: (method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    close: async () => {
      const descendants = (
        await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').catch(() => '')
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await closed;
      clearTimeout(timer);
      lines.close();
      // ACP's private V2 server checkpoints SQLite after the ACP parent exits.
      for (const pid of descendants) {
        let stopped = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
          if (!status || /\) Z /.test(status)) {
            stopped = true;
            break;
          }
          await delay(100);
        }
        assert.ok(stopped, 'private ACP server must stop before copying storage');
      }
    },
  };
}
async function turn(client, sessionId) {
  const start = client.updates.length;
  const result = await client.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with a short fixture response.' }],
  });
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(
    client.updates
      .slice(start)
      .some(
        (update) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.text.includes('fixture reply'),
      ),
  );
}
async function snapshot(directory) {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) entries.push(...(await snapshot(path)));
    else
      entries.push([
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]);
  }
  return entries;
}
try {
  const original = join(root, 'original');
  await mkdir(original);
  // The V1 provider uses its bundled AI SDK; V2 uses its native provider package.
  if (previous) {
    const settings = JSON.parse(await readFile(config, 'utf8'));
    settings.provider.verity.npm = '@ai-sdk/openai-compatible';
    await writeFile(config, JSON.stringify(settings));
  }
  const first = await connect(previous ?? executable, original);
  let sessionId;
  try {
    ({ sessionId } = await first.request('session/new', { cwd: project, mcpServers: [] }));
    await first.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'verity/probe-model',
    });
    await turn(first, sessionId);
  } finally {
    await first.close();
  }
  const before = await snapshot(original);
  const copied = join(root, 'copied');
  await cp(original, copied, { recursive: true });
  const settings = JSON.parse(await readFile(config, 'utf8'));
  settings.provider.verity.npm = '@opencode/ai/providers/openai-compatible';
  await writeFile(config, JSON.stringify(settings));
  for (let restart = 0; restart < 2; restart += 1) {
    const next = await connect(executable, copied);
    try {
      await next.request('session/load', { sessionId, cwd: project, mcpServers: [] });
      assert.ok(
        next.updates.some(
          (update) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.text.includes('fixture reply'),
        ),
      );
      await next.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'verity/probe-model',
      });
      const mode = await next.request('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'plan',
      });
      assert.equal(mode.configOptions.find((option) => option.id === 'mode').currentValue, 'plan');
      await next.request('session/set_config_option', {
        sessionId,
        configId: 'mode',
        value: 'build',
      });
      await turn(next, sessionId);
      if (restart === 1) {
        const started = new Promise((done) => {
          cancellationStarted = done;
        });
        const pending = next.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'cancel-fixture' }],
        });
        await Promise.race([
          started,
          pending.then(() => {
            throw new Error('cancellation fixture completed early');
          }),
        ]);
        next.notify('session/cancel', { sessionId });
        assert.equal((await pending).stopReason, 'cancelled');
      }
    } finally {
      await next.close();
    }
  }
  assert.deepEqual(await snapshot(original), before, 'rollback source must remain untouched');
  assert.ok(calls >= 3, 'all three turns must reach the loopback provider');
  console.log(
    `PASS: ${previous ? 'copied V1 migration' : 'V2 storage'}, replay, mode switching, cancellation, real loopback model turns and two process restarts; rollback source unchanged.`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}
