#!/usr/bin/env node
// Minimal MCP server over streamable HTTP, used only to observe how an ACP
// adapter invokes a client-supplied tool. It executes nothing.
//
// Logs the arrival time of every JSON-RPC message and the full `tools/call`
// params, which is where the call identity of M3 shows up.
//
// It mints a per-run bearer token, writes it to `--token-file` for the driver to
// hand the adapter, and rejects any request that does not present it, so stray
// traffic cannot enter the evidence unnoticed. That buys visibility, not
// isolation: a same-UID process can read the token, and M4 is the finding that
// the adapter publishes it on its own command line regardless.
//
//   RUN=$(mktemp -d)
//   node mcp-probe-server.mjs --port 8765 --log "$RUN/probe.log" --token-file "$RUN/token"

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const LOG = arg('log', '/tmp/acp-probe.log');
const TOKEN_FILE = arg('token-file');
if (!TOKEN_FILE) {
  // No default: a fixed `/tmp` path is guessable, and a neighbour that plants a
  // symlink there first turns this write into a write to a file of their
  // choosing. Requiring a caller-supplied path inside a fresh `mktemp -d`
  // directory removes the guess.
  console.error('--token-file is required; use a path inside a fresh `mktemp -d` directory');
  process.exit(1);
}

// Minted per run, so no secret-shaped literal lives in the source.
const TOKEN = `probe-${randomBytes(12).toString('hex')}`;
try {
  // `wx` is O_CREAT|O_EXCL: it fails on an existing path including a symlink,
  // rather than following one, so the create cannot be redirected.
  writeFileSync(TOKEN_FILE, TOKEN, { flag: 'wx', mode: 0o600 });
} catch (error) {
  console.error(`could not create ${TOKEN_FILE} (${error.code}); use a fresh directory per run`);
  process.exit(1);
}

const stamp = (kind, payload) => {
  const json = JSON.stringify(payload).replaceAll(TOKEN, '<redacted>');
  appendFileSync(LOG, `${Date.now()} ${kind} ${json}\n`);
};

const TOOL = {
  name: 'verity_probe_secret',
  description: 'Probe tool standing in for a brokered secret tool. Call it when asked.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string', description: 'target name' } },
    required: ['target'],
  },
};

const server = createServer((req, res) => {
  // The endpoint the design argues about is an authenticated one, so this probe
  // is authenticated too, and a request that arrives without the token is
  // recorded rather than silently mixed into the evidence. A plain comparison is
  // enough for that: anything able to mount a timing attack from this container
  // can read the token outright.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    stamp('MCP_UNAUTHORIZED', {
      method: req.method,
      url: req.url,
      hasAuthorization: Boolean(req.headers.authorization),
    });
    res.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    req.resume();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      // The client also opens a GET SSE stream; refusing it does not stop the
      // POST path from working, which is itself worth recording.
      stamp('MCP_NON_RPC', { method: req.method, url: req.url, accept: req.headers.accept });
      res.writeHead(400).end();
      return;
    }
    // Reaching here means the request carried the per-run credential; the
    // unauthenticated case is its own kind above.
    stamp('MCP_HTTP', { rpc: msg.method });
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'verity-probe', version: '0.0.0' },
      });
    } else if (msg.method === 'tools/list') {
      reply({ tools: [TOOL] });
    } else if (msg.method === 'tools/call') {
      // Full params: `_meta` is where an adapter-supplied call identity appears.
      stamp('MCP_TOOLS_CALL', { params: msg.params });
      reply({ content: [{ type: 'text', text: 'probe-ok' }] });
    } else if (msg.id !== undefined) {
      reply({});
    } else {
      res.writeHead(202).end();
    }
  });
});

/** Take the endpoint and the credential down together, and do not rely on the
 *  caller to remember. A probe server left listening outsurvives the run it was
 *  minted for: its token stays valid on disk, and its port silently answers the
 *  next measurement, which is how one run's traffic ends up in another's log. */
const shutdown = (reason) => {
  stamp('MCP_SERVER_STOP', { reason });
  try {
    unlinkSync(TOKEN_FILE);
  } catch {
    /* already gone */
  }
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));
setTimeout(() => shutdown('expiry'), Number(arg('expire', '600000')));

server.listen(Number(arg('port', '8765')), '127.0.0.1', () => {
  stamp('MCP_SERVER_READY', { port: server.address().port, tokenFile: TOKEN_FILE });
});
