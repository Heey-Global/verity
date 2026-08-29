#!/usr/bin/env node
/**
 * Harden the globally installed `@agentclientprotocol/claude-agent-acp` against
 * tool-title render crashes (upstream, present through 0.66.0).
 *
 * `toolInfoFromToolUse` (dist/tools.js) builds the human-readable title for a
 * tool call straight out of the model's tool input, which is untrusted JSON —
 * the schema is a request to the model, not a guarantee. Fields are read without
 * checking their shape, and they fail in two different ways:
 *
 *   WebSearch       input.allowed_domains.join(", ")   // documented string[]
 *   WebSearch       input.blocked_domains.join(", ")   // documented string[]
 *   ReportFindings  input.findings.map(...)            // documented object[]
 *     — these THROW on a wrong type.
 *
 *   Task            title: input.description            // documented string
 *   Bash            title: input.command                // documented string
 *   Write           locations: [{ path: input.file_path }]
 *     — these return the raw value, so a wrong type reaches the ACP schema as a
 *       non-string and is rejected a layer later, outside any try here.
 *
 * A model that emits `"allowed_domains": "github.com"` therefore produces
 * `TypeError: input.allowed_domains.join is not a function`. The throw is not
 * contained: it leaves the SDK query stream, the ACP agent exits 1 without a
 * terminal event, and Verity settles the turn as `crashed`. Worse, the block is
 * already persisted in session history and `loadSession` replays history through
 * this same function — so every resume re-throws at the same block and the
 * session is permanently unresumable. A cosmetic label costs the whole session.
 *
 * The fix is layered, and both layers matter:
 *
 *   1. Wrap the whole function so NO title can ever end a session — neither by
 *      throwing nor by handing the protocol a non-string title. Field guards are
 *      whack-a-mole; the wrapper bounds the blast radius of the next unvalidated
 *      field to a degraded label.
 *   2. Guard the known fields on top, so those titles stay correct rather than
 *      merely non-fatal.
 *
 * Run after `npm install -g @agentclientprotocol/claude-agent-acp@<pin>`. The
 * wrapper goes on unconditionally while the seam exists — an upstream that fixes
 * today's three fields can still grow a fourth, and the probe set only ever
 * knows about yesterday's. Probes therefore decide which *guards* apply and
 * verify the result; they never decide whether to protect at all.
 *
 * The script is version-tolerant: guards that no longer match are skipped, so a
 * Renovate bump onto a partly- or fully-fixed upstream needs no action here. It
 * fails the build when the seam itself is gone, because that is the one outcome
 * that must never pass silently — a build that ships an unhardened adapter looks
 * exactly like one that ships a hardened adapter until a session dies. Re-derive
 * the seam then, or, if upstream has published its own boundary, delete this
 * script together with its two call sites.
 *
 * Usage: verity-claude-acp-harden.mjs [packageDir]
 *        VERITY_CLAUDE_ACP_DIR=<packageDir> verity-claude-acp-harden.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LABEL = 'verity-claude-acp-harden';
const MARKER = 'verity:tool-title-hardening';

/** Tool inputs that are valid JSON, wrong-typed, and reachable from any turn.
 *  Each must survive the hardened copy — rendering *something*, and rendering a
 *  string.
 *
 *  One probe per unguarded field, not one per tool: a field missing from this
 *  list is a field an upstream can leave broken while the post-check still
 *  passes, so `blocked_domains` gets its own entry next to `allowed_domains`.
 *  The last two cover the quieter failure: a title that does not throw but is
 *  not a string either, which the ACP schema rejects downstream. */
const PROBES = [
  {
    what: 'WebSearch allowed_domains',
    name: 'WebSearch',
    input: { query: 'probe', allowed_domains: 'example.com' },
  },
  {
    what: 'WebSearch blocked_domains',
    name: 'WebSearch',
    input: { query: 'probe', blocked_domains: 'example.com' },
  },
  { what: 'ReportFindings findings', name: 'ReportFindings', input: { findings: 'not-an-array' } },
  { what: 'Task description', name: 'Task', input: { description: { not: 'a string' } } },
  {
    what: 'Write file_path',
    name: 'Write',
    input: { file_path: { not: 'a string' }, content: '' },
  },
];

/** The `export function` line is the wrapper seam: the original body becomes an
 *  inner function and the exported name gains the try/catch. */
const SIGNATURE_ANCHOR =
  'export function toolInfoFromToolUse(toolUse, supportsTerminalOutput = false, cwd) {\n' +
  '    const name = toolUse.name;';

const SIGNATURE_REPLACEMENT = `/* ${MARKER}: a tool-call title is display-only, so building one must never
 * be able to end the session. An unguarded throw here leaves the SDK query
 * stream and exits the agent process, and because \`loadSession\` replays
 * history through this same function, the offending block re-throws on every
 * resume — the session never recovers. Model-authored tool input is untrusted
 * JSON: the field guards below keep titles CORRECT, this backstop keeps the
 * next unvalidated field from costing a session.
 *
 * Two failure modes, not one. Several branches hand a raw input field straight
 * back as \`title\` (\`Task.description\`, \`Bash.command\`) or as a location
 * (\`Write.file_path\`), so a wrong-typed field that does NOT throw still leaves
 * the ACP schema with a non-string where it requires a string — rejected a layer
 * later, outside this try. Both are normalised here. \`kind\` is a literal in
 * every branch and \`content\` is structurally checked by the client, so neither
 * is rewritten. */
export function toolInfoFromToolUse(toolUse, supportsTerminalOutput = false, cwd) {
    const fallbackTitle = typeof toolUse?.name === "string" && toolUse.name.length > 0
        ? toolUse.name
        : "Tool";
    let info;
    try {
        info = toolInfoFromToolUseUnguarded(toolUse, supportsTerminalOutput, cwd);
    }
    catch {
        return { title: fallbackTitle, kind: "other", content: [] };
    }
    if (!info || typeof info !== "object") {
        return { title: fallbackTitle, kind: "other", content: [] };
    }
    if (typeof info.title !== "string" || info.title.length === 0) {
        info.title = fallbackTitle;
    }
    if (info.locations !== undefined) {
        info.locations = Array.isArray(info.locations)
            ? info.locations.filter((location) => typeof location?.path === "string")
            : [];
    }
    return info;
}
function toolInfoFromToolUseUnguarded(toolUse, supportsTerminalOutput = false, cwd) {
    const name = toolUse.name;`;

/** Optional, cosmetic-but-worth-it: keep a WebSearch title informative instead
 *  of falling into the backstop. Skipped without failing if upstream reshapes
 *  it — the backstop already covers correctness. */
const WEBSEARCH_GUARDS = [
  {
    what: 'WebSearch allowed_domains',
    from: 'if (input?.allowed_domains && input.allowed_domains.length > 0) {',
    to: 'if (Array.isArray(input?.allowed_domains) && input.allowed_domains.length > 0) {',
  },
  {
    what: 'WebSearch blocked_domains',
    from: 'if (input?.blocked_domains && input.blocked_domains.length > 0) {',
    to: 'if (Array.isArray(input?.blocked_domains) && input.blocked_domains.length > 0) {',
  },
];

/** Build-log lines, in install.sh's `>>` / `!!` idiom. Written directly rather
 *  than through `console`, which these Feature scripts do not assume. */
function note(message) {
  process.stdout.write(`>> ${LABEL}: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`!! ${LABEL}: ${message}\n`);
  process.exit(1);
}

function resolvePackageDir() {
  const explicit = process.argv[2] || process.env.VERITY_CLAUDE_ACP_DIR;
  if (explicit) return explicit;
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return path.join(globalRoot, '@agentclientprotocol', 'claude-agent-acp');
}

/**
 * Import the module under test and render each probe input. The query string
 * defeats the ESM module cache so the post-write import sees the new bytes.
 * Returns the first failure, or null when every probe renders a usable title.
 */
async function probeFailure(file, stage) {
  const url = `${pathToFileURL(file).href}?${LABEL}=${stage}`;
  let toolInfoFromToolUse;
  try {
    ({ toolInfoFromToolUse } = await import(url));
  } catch (error) {
    fail(`cannot import ${file}: ${error?.message ?? error}`);
  }
  if (typeof toolInfoFromToolUse !== 'function') {
    fail(`${file} no longer exports toolInfoFromToolUse — re-derive this hardening.`);
  }
  for (const probe of PROBES) {
    let info;
    try {
      info = toolInfoFromToolUse({ name: probe.name, id: `${LABEL}-probe`, input: probe.input });
    } catch (error) {
      return `${probe.what} title threw ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`;
    }
    if (typeof info?.title !== 'string') {
      return `${probe.what} rendered a non-string title (${typeof info?.title}) — the ACP schema rejects it downstream`;
    }
    if (info.locations !== undefined && !Array.isArray(info.locations)) {
      return `${probe.what} rendered non-array locations (${typeof info.locations})`;
    }
    for (const location of info.locations ?? []) {
      if (typeof location?.path !== 'string') {
        return `${probe.what} rendered a non-string location path (${typeof location?.path})`;
      }
    }
  }
  return null;
}

const packageDir = resolvePackageDir();
const toolsFile = path.join(packageDir, 'dist', 'tools.js');

let source;
try {
  source = await readFile(toolsFile, 'utf8');
} catch (error) {
  fail(`cannot read ${toolsFile}: ${error?.message ?? error}`);
}

if (source.includes(MARKER)) {
  note(`${toolsFile} is already hardened — nothing to do.`);
  process.exit(0);
}

const defect = await probeFailure(toolsFile, 'pre');
note(
  defect
    ? `unhardened copy detected (${defect})`
    : 'this copy renders every known wrong-typed input safely; installing the backstop anyway.',
);

if (!source.includes(SIGNATURE_ANCHOR)) {
  // Deliberately fatal even when the probes came back clean. The probes only
  // know the fields that were broken yesterday; the backstop is what covers the
  // ones nobody has hit yet, so losing the seam means losing the protection —
  // and an unprotected build is indistinguishable from a protected one right up
  // until a session dies. Re-derive the seam, or retire this script on purpose.
  fail(
    `upstream restructured dist/tools.js: the toolInfoFromToolUse seam is gone, so the ` +
      `title backstop cannot be installed` +
      (defect ? ` and wrong-typed input still crashes (${defect})` : '') +
      `. Re-derive the hardening against the pinned version, or drop this script together ` +
      `with its two call sites if upstream now guards titles itself.`,
  );
}

let hardened = source.replace(SIGNATURE_ANCHOR, SIGNATURE_REPLACEMENT);

for (const guard of WEBSEARCH_GUARDS) {
  if (hardened.includes(guard.from)) {
    hardened = hardened.replace(guard.from, guard.to);
    note(`guarded ${guard.what}`);
  } else {
    note(`${guard.what} guard not applicable — backstop still covers it.`);
  }
}

await writeFile(toolsFile, hardened);

const stillBroken = await probeFailure(toolsFile, 'post');
if (stillBroken) {
  fail(`hardening applied but ${toolsFile} still renders unsafely: ${stillBroken}`);
}

note(`hardened ${toolsFile}`);
