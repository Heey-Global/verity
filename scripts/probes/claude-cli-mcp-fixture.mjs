#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcpConfigIndex = process.argv.indexOf('--mcp-config');
const rawMcpConfig = mcpConfigIndex < 0 ? undefined : process.argv[mcpConfigIndex + 1];
if (rawMcpConfig === undefined) throw new Error('Claude ACP did not pass --mcp-config');
const server = JSON.parse(rawMcpConfig)?.mcpServers?.verity;
if (
  server?.type !== 'http' ||
  server.url !== process.env.EXPECTED_MCP_URL ||
  server.headers?.Authorization !== `Bearer ${process.env.EXPECTED_MCP_TOKEN}`
) {
  throw new Error(
    `unexpected MCP config: ${JSON.stringify({
      type: server?.type,
      url: server?.url,
      headerNames: Object.keys(server?.headers ?? {}),
    })}`,
  );
}

// A real MCP client, not hand-written requests: the Claude CLI this fixture stands in
// for reaches the gateway through one, and a request Verity composed itself cannot show
// that the handshake, the declared schemas or the result envelope survive a client that
// did not. #1411 was exactly that blind spot one hop further out.
const client = new Client({ name: 'claude-cli-mcp-fixture', version: '1' });
// Everything the transport fails at outside a request/response pair lands here and nowhere
// else. Chief among them: the GET stream it opens for server-initiated messages the moment
// the handshake completes, whose failure is reported asynchronously and would otherwise
// leave a gateway that rejects it looking perfectly healthy from inside this fixture.
const transportErrors = [];
client.onerror = (error) => transportErrors.push(error);
// That stream is opened without being awaited, so nothing downstream of `connect()` is
// ordered against it: a check placed after the calls below would race whatever the gateway
// answered. Report its status through the transport's own `fetch` and await that instead.
let observeStreamStatus;
const streamStatus = new Promise((resolve) => {
  observeStreamStatus = resolve;
});
await client.connect(
  new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if ((init?.method ?? 'GET') === 'GET') {
        // Reported a turn late, on purpose. Everything the transport does with this
        // response — read the status, cancel the body, route a failure to `onerror` —
        // happens in microtasks chained onto the `fetch` this line is returning from, so
        // resolving inline would put the status in hand before the error it implies. A
        // timer runs after that whole chain has drained.
        setTimeout(() => observeStreamStatus(response.status), 0);
      }
      return response;
    },
  }),
);

const listed = await client.listTools();
const served = listed.tools.map((tool) => tool.name).sort();
// The whole set, not its first element: a positional check passes unchanged when a tool
// goes missing behind the one it happens to look at.
const expected = ['verity_http_request', 'verity_secret_run'];
if (served.join(',') !== expected.join(',')) {
  throw new Error(`gateway tools/list served ${JSON.stringify(served)}`);
}

// One call per served tool. `verity_secret_run` carries the more elaborate schema of the
// two — nested secrets, an absolute-path refinement — so it is the one whose declaration
// a real client is most likely to reject.
const calls = [
  {
    name: 'verity_http_request',
    arguments: {
      method: 'GET',
      url: 'https://api.example.invalid/e2e',
      secretAlias: 'E2E_TOKEN',
      auth: { header: 'authorization', scheme: 'Bearer' },
    },
  },
  {
    name: 'verity_secret_run',
    arguments: {
      secrets: [{ secretAlias: 'E2E_TOKEN', env: 'E2E_TOKEN' }],
      command: ['/usr/bin/true'],
    },
  },
];
for (const call of calls) {
  const result = await client.callTool(call);
  if (result.isError === true) {
    throw new Error(`gateway tools/call ${call.name} failed: ${JSON.stringify(result.content)}`);
  }
}
// 405 is the one answer the transport reads as "no stream here"; on anything else it raises
// the connection error collected above. Raced against a deadline so a client that never
// opens the stream says so, rather than hanging the ACP session out to its own timeout.
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
// Checked before `close()`, which aborts anything still in flight and would report that as
// an error of its own.
if (transportErrors.length > 0) {
  throw new Error(`gateway transport error: ${transportErrors.map(String).join('; ')}`);
}
await client.close();

const sessionId = 'real-claude-acp-e2e';
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  claude_code_version: 'e2e-fixture',
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [{ name: 'verity', status: 'connected' }],
  model: 'fixture',
  permissionMode: 'default',
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
  uuid: '00000000-0000-4000-8000-000000000011',
  session_id: sessionId,
});

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: frame.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [{ value: 'fixture', displayName: 'Fixture', description: 'E2E fixture' }],
          account: { apiKeySource: 'none', apiProvider: 'firstParty' },
        },
        pending_permission_requests: [],
        pending_user_dialog_requests: [],
      },
    });
    continue;
  }
  if (frame.type !== 'user') continue;
  emit({
    type: 'assistant',
    message: {
      id: 'claude-message-e2e',
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text: 'Claude ACP gateway reached' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 4,
      },
    },
    parent_tool_use_id: null,
    uuid: '00000000-0000-4000-8000-000000000012',
    session_id: sessionId,
  });
  emit({
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: 'Claude ACP gateway reached',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000013',
    session_id: sessionId,
  });
  input.close();
}
