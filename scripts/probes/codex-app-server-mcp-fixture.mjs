#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

async function answer(message) {
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({ id, result: { codexHome: process.cwd() } });
    return;
  }
  if (method === 'account/read') {
    send({
      id,
      result: {
        account: { type: 'chatgpt', email: 'ci@example.invalid' },
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (method === 'skills/extraRoots/set') {
    send({ id, result: {} });
    return;
  }
  if (method === 'skills/list') {
    send({ id, result: { data: [] } });
    return;
  }
  if (method === 'config/read') {
    send({ id, result: { config: {}, layers: [] } });
    return;
  }
  if (method === 'thread/start') {
    const server = params?.config?.mcp_servers?.verity;
    if (
      !server ||
      server.url !== process.env.EXPECTED_MCP_URL ||
      server.http_headers?.Authorization !== `Bearer ${process.env.EXPECTED_MCP_TOKEN}`
    ) {
      throw new Error(`unexpected MCP config: ${JSON.stringify(server)}`);
    }
    // A real MCP client rather than hand-written requests — see the note in
    // scripts/probes/claude-cli-mcp-fixture.mjs.
    const client = new Client({ name: 'codex-app-server-mcp-fixture', version: '1' });
    // Asynchronous transport failures, chiefly the server-message GET stream — see the note
    // in scripts/probes/claude-cli-mcp-fixture.mjs.
    const transportErrors = [];
    client.onerror = (error) => transportErrors.push(error);
    let observeStreamStatus;
    const streamStatus = new Promise((resolve) => {
      observeStreamStatus = resolve;
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.http_headers },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          // Reported a turn late, on purpose — see the note in
          // scripts/probes/claude-cli-mcp-fixture.mjs.
          if ((init?.method ?? 'GET') === 'GET') {
            setTimeout(() => observeStreamStatus(response.status), 0);
          }
          return response;
        },
      }),
    );
    const listed = await client.listTools();
    const served = listed.tools.map((tool) => tool.name).sort();
    // The whole set, not its first element: a positional check passes unchanged when a
    // tool goes missing behind the one it happens to look at.
    const expected = ['verity_http_request', 'verity_secret_run'];
    if (served.join(',') !== expected.join(',')) {
      throw new Error(`gateway tools/list served ${JSON.stringify(served)}`);
    }
    // Awaited, not polled — see the note in scripts/probes/claude-cli-mcp-fixture.mjs. The
    // rejection joins this handler's own error path, which reports and exits non-zero.
    let cancelDeadline = () => {};
    const streamDeadline = new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the MCP client never opened the server-message stream')),
        5_000,
      );
      timer.unref();
      cancelDeadline = () => clearTimeout(timer);
    });
    const observed = await Promise.race([streamStatus, streamDeadline]);
    cancelDeadline();
    if (observed !== 405) {
      throw new Error(`gateway answered the server-message stream ${observed}`);
    }
    if (transportErrors.length > 0) {
      throw new Error(`gateway transport error: ${transportErrors.map(String).join('; ')}`);
    }
    await client.close();
    send({
      id,
      result: {
        thread: { id: 'real-codex-acp-e2e' },
        model: 'gpt-5.1-codex',
        reasoningEffort: 'medium',
        modelProvider: 'openai',
      },
    });
    return;
  }
  if (method === 'model/list') {
    send({
      id,
      result: {
        data: [
          {
            id: 'gpt-5.1-codex',
            model: 'gpt-5.1-codex',
            displayName: 'gpt-5.1-codex',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text'],
            supportsPersonality: false,
            isDefault: true,
          },
        ],
        nextCursor: null,
      },
    });
    return;
  }
  if (method === 'turn/start') {
    const turn = {
      id: 'codex-turn-e2e',
      items: [],
      status: 'completed',
      error: null,
    };
    send({ id, result: { turn } });
    send({ method: 'turn/completed', params: { threadId: params.threadId, turn } });
    return;
  }
  send({ id, result: {} });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  void answer(JSON.parse(line)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
    input.close();
  });
});
