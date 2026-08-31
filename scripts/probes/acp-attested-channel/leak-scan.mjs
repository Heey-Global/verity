#!/usr/bin/env node
// M4: does the MCP endpoint Verity hands an ACP adapter, and the credential in
// its `Authorization` header, reach a same-UID workspace process?
//
// Split out of the driver on purpose. `/proc` access to another task's `environ`
// and descriptors goes through a ptrace-mode check, and an ancestor can pass
// checks a workspace process cannot — so a scan run inside the driver, which is
// the adapter's *parent*, would answer an easier question than the one the threat
// model asks. Running this as its own process lets the same scan be mounted from
// each position that matters:
//
//   --label parent            spawned by the driver, adapter is a child
//   --label sibling           spawned by the driver, adapter is a sibling
//   --label agent-descendant  run by the agent's own Bash tool, so the adapter is
//                             an ancestor — the position an actual repository
//                             command occupies, and the hardest one to read from
//
// It looks for the port and for a bearer credential, never for the token value,
// so it needs no oracle and can be run by the agent under test.
//
//   node leak-scan.mjs --port 8765 --log "$RUN/probe.log" --label sibling

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const PORT = arg('port', '8765');
const LOG = arg('log', '/tmp/acp-probe.log');
const LABEL = arg('label', 'unlabelled');

/**
 * The command lines this scan reports are the very thing it is looking for, so
 * they cannot be recorded raw: the adapter's `--mcp-config` carries a live
 * `Authorization` header, and a shorter command than the one measured here would
 * put the credential inside the excerpt. Strip the value, keep the shape — the
 * finding is that a bearer credential is readable, never which one.
 */
const redact = (text) =>
  text
    // The header form first, so it takes the whole value including a `Bearer`
    // prefix; running the bare-`Bearer` rule first would leave the token behind.
    .replaceAll(/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[^\s"',}]+/gi, '$1<redacted>')
    .replaceAll(/bearer\s+[^\s"',}]+/gi, 'Bearer <redacted>');

const read = (pid, file) => {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch (error) {
    return { error: error.code ?? 'UNKNOWN' };
  }
};

const hits = [];
// Denominators: a scan that finds nothing because everything was unreadable is a
// different result from one that finds nothing because there was nothing to find.
const readable = { cmdline: 0, environ: 0 };
const refused = { cmdline: 0, environ: 0 };

for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
  if (pid === String(process.pid)) continue;
  const found = {};
  for (const file of ['cmdline', 'environ']) {
    const text = read(pid, file);
    if (typeof text !== 'string') {
      // ESRCH just means the process exited between listing and reading.
      if (text.error !== 'ENOENT' && text.error !== 'ESRCH') refused[file]++;
      continue;
    }
    readable[file]++;
    if (text.includes(`:${PORT}`)) found[`${file}.url`] = true;
    if (/Bearer\s/.test(text)) found[`${file}.bearer`] = true;
  }
  if (Object.keys(found).length === 0) continue;
  const cmd = read(pid, 'cmdline');
  const command = typeof cmd === 'string' ? cmd.replaceAll('\0', ' ').trim() : '';
  hits.push({
    pid,
    ...found,
    // The probe's own processes carry the port on their command line too; that is
    // an artefact of measuring, not a finding.
    probe: command.includes('probes/acp-attested-channel'),
    // Long enough to reach the `--mcp-config` blob, which is the point: with the
    // value stripped, the excerpt shows the shape of the leak and not the secret.
    cmd: redact(command).slice(0, 300),
  });
}

const result = {
  label: LABEL,
  scanner: { pid: process.pid, ppid: process.ppid },
  readable,
  refused,
  hits,
};
appendFileSync(LOG, `${Date.now()} M4_LEAK ${JSON.stringify(result)}\n`);
// Also to stdout, so the agent-descendant run reports through its tool output.
const real = hits.filter((h) => !h.probe);
console.log(
  `M4_LEAK ${LABEL}: ${real.length} non-probe hit(s); ` +
    `readable cmdline=${readable.cmdline} environ=${readable.environ}, ` +
    `refused cmdline=${refused.cmdline} environ=${refused.environ}`,
);
for (const h of real) console.log(`  ${JSON.stringify(h)}`);
