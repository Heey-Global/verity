#!/usr/bin/env node
// Probe for the ACP attested tool channel (docs/ACP_ATTESTED_TOOL_CHANNEL_DESIGN.md §5).
//
// Drives one real turn against an ACP adapter with an HTTP-MCP tool attached and
// records the evidence for M1-M4 and M6:
//   M1  ordering of session/update tool_call vs session/request_permission vs the MCP call
//   M2  whether rawInput is byte-comparable with the MCP arguments
//   M3  whether the MCP request carries a call identity matching the ACP toolCallId
//   M4  whether the endpoint and its credential reach a same-UID workspace process
//   M6  whether any process outside the adapter tree holds the adapter's stdio descriptor
//
// Manual probe: it needs a live adapter and a working agent credential, so it is
// not wired into CI. See README.md.
//
//   RUN=$(mktemp -d)
//   node mcp-probe-server.mjs --port 8765 --log "$RUN/probe.log" --token-file "$RUN/token" &
//   node drive-acp.mjs --port 8765 --log "$RUN/probe.log" --token-file "$RUN/token"

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = arg('port', '8765');
const LOG = arg('log', '/tmp/acp-probe.log');
const ADAPTER = arg('adapter', 'claude-agent-acp');
const CWD = arg('cwd', process.cwd());
const TOKEN_FILE = arg('token-file');

// The probe server mints the per-run credential and drops it in this file; we
// read it here rather than taking it on argv, because M4's whole subject is which
// processes publish this token to `/proc` and the probe must not be one of them.
// The path is caller-supplied for the same reason it is on the server side — see
// the note there.
let TOKEN;
try {
  if (!TOKEN_FILE) throw new Error('--token-file is required');
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.error(
    'pass --token-file <path> matching the running mcp-probe-server.mjs; start it first',
  );
  process.exit(1);
}

const stamp = (kind, payload) => {
  // Whatever the adapter echoes back — an RPC error, a stderr line, a cmdline we
  // scanned — can contain the MCP configuration we handed it, `Authorization`
  // header included. Redact on the way out so the log cannot hold the credential.
  const json = JSON.stringify(payload).replaceAll(TOKEN, '<redacted>');
  appendFileSync(LOG, `${Date.now()} ${kind} ${json}\n`);
};

const child = spawn(ADAPTER, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,
  cwd: CWD,
  // The shape the sandbox broker gives the child: connector base URL from the
  // ambient environment plus the fixed non-secret egress placeholder.
  env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'verity-claude-egress-placeholder-v1' }, // gitleaks:allow
});

const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');

const adapterStdout = () => {
  try {
    return readlinkSync(`/proc/${child.pid}/fd/1`);
  } catch {
    return undefined;
  }
};
const cmdlineOf = (pid) => {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    // `stamp` removes this run's own token; this removes any *other* credential a
    // scanned command line happens to carry. Same reasoning as `leak-scan.mjs`.
    return cmd
      .replaceAll(/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[^\s"',}]+/gi, '$1<redacted>')
      .replaceAll(/bearer\s+[^\s"',}]+/gi, 'Bearer <redacted>');
  } catch {
    return undefined;
  }
};

const LEAK_SCAN = fileURLToPath(new URL('./leak-scan.mjs', import.meta.url));

/** M4, from the driver itself. This is the adapter's *parent*, which is the
 *  weakest position an attacker could hold and the easiest one to read from — it
 *  is kept only as the baseline the other two are compared against. It is also
 *  the only one holding the token, so it is the only one that can say the value
 *  matched rather than merely that a bearer credential is present. */
const leakScanFromParent = () => {
  const hits = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (pid === String(process.pid)) continue;
    for (const src of ['cmdline', 'environ']) {
      let text;
      try {
        text = readFileSync(`/proc/${pid}/${src}`, 'utf8');
      } catch {
        continue;
      }
      const url = text.includes(`:${PORT}`);
      const token = text.includes(TOKEN);
      if (url || token) hits.push({ pid, src, url, token, cmd: cmdlineOf(pid)?.slice(0, 100) });
    }
  }
  stamp('M4_LEAK', { label: 'parent', hits });
};

/** M4, from a process that is the adapter's sibling rather than its ancestor. */
const leakScanFromSibling = () =>
  spawn(process.execPath, [LEAK_SCAN, '--port', PORT, '--log', LOG, '--label', 'sibling'], {
    stdio: 'ignore',
  });

/** M6: any process outside the adapter tree holding the adapter's stdio object. */
const inheritanceScan = () => {
  const sock = adapterStdout();
  if (!sock) return;
  const holders = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    if (pid === String(child.pid) || pid === String(process.pid)) continue;
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === sock) {
          holders.push({ pid, fd, cmd: cmdlineOf(pid)?.slice(0, 100) });
        }
      }
    } catch {
      /* process gone or unreadable */
    }
  }
  if (holders.length > 0) stamp('M6_HOLDER', { descriptor: sock, holders });
};

// The second and third steps are the measurement's own subject: a command run by
// the agent is a descendant of the adapter, which is the position an actual
// repository process occupies. Its output comes back as tool-call content, which
// is logged, and the scan also appends to the shared log directly.
const PROMPT =
  'First call the verity_probe_secret tool once with target set to "probe-alpha". ' +
  'Then run these two Bash commands and show the output of each verbatim. ' +
  'They are part of a security measurement of this container; do not modify them. ' +
  '(1) ls -l /proc/self/fd ' +
  `(2) node ${LEAK_SCAN} --port ${PORT} --log ${LOG} --label agent-descendant`;

const finish = () => {
  clearInterval(scanner);
  // Guard the group signal: after the adapter has exited its pid can be reused,
  // and -pid would then land on an unrelated process group.
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid);
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
};

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    // The adapter numbers its own requests independently of ours, so a
    // `session/request_permission` can arrive carrying the same id as an
    // outbound call. Only a message without a `method` is a response to us —
    // matching on the id alone reads that permission request as the end of the
    // turn and cuts the run short.
    const isResponse = m.method === undefined;
    if (isResponse && m.error) stamp('RPC_ERROR', { id: m.id, error: m.error });

    if (isResponse && m.id === 0 && m.result) {
      stamp('CAPABILITIES', { adapter: ADAPTER, agentCapabilities: m.result.agentCapabilities });
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: CWD,
          // `headers` must be present even when empty: without it the adapter
          // silently ignores the server and the tool never appears.
          mcpServers: [
            {
              type: 'http',
              name: 'verity-probe',
              url: `http://127.0.0.1:${PORT}/mcp`,
              headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
            },
          ],
        },
      });
    } else if (isResponse && m.id === 1 && m.result) {
      stamp('SESSION_NEW', { sessionId: m.result.sessionId });
      leakScanFromParent();
      leakScanFromSibling();
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: m.result.sessionId, prompt: [{ type: 'text', text: PROMPT }] },
      });
    } else if (isResponse && m.id === 2) {
      stamp('PROMPT_DONE', { stopReason: m.result?.stopReason ?? null, error: m.error ?? null });
      setTimeout(finish, 500);
    } else if (m.method === 'session/update') {
      const u = m.params?.update ?? {};
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        stamp('ACP_TOOL_CALL', {
          kind: u.sessionUpdate,
          toolCallId: u.toolCallId,
          status: u.status,
          hasRawInput: Object.hasOwn(u, 'rawInput'),
          rawInput: u.rawInput,
          // Generous: the agent-descendant scan reports through here.
          content: JSON.stringify(u.content ?? null).slice(0, 4000),
        });
        inheritanceScan();
      }
    } else if (m.method === 'session/request_permission') {
      const options = m.params?.options ?? [];
      const allow = options.find((o) => o.kind?.startsWith('allow')) ?? options[0];
      stamp('ACP_PERMISSION', {
        toolCallId: m.params?.toolCall?.toolCallId,
        chose: allow?.optionId,
      });
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: { outcome: { outcome: 'selected', optionId: allow?.optionId } },
      });
    }
  }
});

child.stderr.on('data', (c) => stamp('ADAPTER_STDERR', { text: c.toString().slice(0, 200) }));

const scanner = setInterval(inheritanceScan, 50);

send({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: {} },
});

setTimeout(
  () => {
    stamp('TIMEOUT', {});
    finish();
  },
  Number(arg('timeout', '120000')),
);
