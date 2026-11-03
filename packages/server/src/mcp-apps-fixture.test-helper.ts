import type { McpRpc } from './mcp-apps.js';

/** Standalone standard-protocol view; no network assets are required. */
const dashboardHtml = `<!doctype html><html><body>
<h1>Dashboard</h1><output id="count">Waiting for data</output><button id="refresh">Refresh</button>
<script>
let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}
function show(result) {
  document.getElementById('count').textContent = 'Count: ' + result.structuredContent.count;
}
addEventListener('message', (event) => {
  if (event.source !== parent) return;
  const message = event.data;
  if (message.method === 'ui/notifications/tool-result') show(message.params);
  const waiter = pending.get(message.id);
  if (waiter) {
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  }
});
document.getElementById('refresh').onclick = async () => {
  const button = document.getElementById('refresh');
  button.disabled = true;
  try { show(await request('tools/call', { name: 'refresh', arguments: {} })); }
  catch (error) { document.getElementById('count').textContent = error.message; }
  finally { button.disabled = false; }
};
request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Dashboard fixture', version: '1.0.0' }, appCapabilities: {} })
  .then(() => parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*'));
</script></body></html>`;

/** Deterministic MCP dashboard, including an app-only refresh tool. */
export function dashboardFixture() {
  let count = 0;
  const calls: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  const tools = [
    {
      name: 'dashboard',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://dashboard' } },
    },
    { name: 'refresh', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } },
    {
      name: 'model_only',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } },
    },
  ];
  const rpc: McpRpc = async (_connection, method, params, sessionId) => {
    calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (method === 'initialize')
      return { sessionId: 'fixture-session', result: { protocolVersion: '2025-11-25' } };
    if (method === 'notifications/initialized') return { result: {} };
    if (method === 'tools/list') return { result: { tools } };
    if (method === 'resources/read')
      return {
        result: {
          contents: [
            { uri: 'ui://dashboard', mimeType: 'text/html;profile=mcp-app', text: dashboardHtml },
          ],
        },
      };
    if (method === 'tools/call')
      return {
        result: {
          content: [{ type: 'text', text: `Count: ${String(++count)}` }],
          structuredContent: { count },
          _meta: { privateToApp: true },
        },
      };
    throw new Error(`Unsupported fixture method ${method}`);
  };
  return { rpc, calls, tools };
}
