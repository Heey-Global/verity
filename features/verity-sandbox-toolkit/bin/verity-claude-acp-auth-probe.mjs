#!/usr/bin/env node
// Claude root options must precede the auth subcommand.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root =
  process.argv[2] ??
  path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    '@agentclientprotocol',
    'claude-agent-acp',
  );
// The auth status probe lived in dist/acp-agent.js through 0.103 and moved to
// dist/auth-status-reporter.js in 0.104 (the v1 agent moved to dist/v1/).
const candidates = ['acp-agent.js', 'v1/acp-agent.js', 'auth-status-reporter.js'].map((name) =>
  path.join(root, 'dist', name),
);
const original = 'args.push("--settings", JSON.stringify(context.override));';
const fixed = 'args.unshift("--settings", JSON.stringify(context.override));';
const sources = [];
for (const file of candidates) {
  try {
    sources.push({ file, source: await readFile(file, 'utf8') });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
const count = (text, needle) => text.split(needle).length - 1;
const unordered = sources.filter(({ source }) => source.includes(original));
const ordered = sources.filter(({ source }) => source.includes(fixed));
if (unordered.length > 1 || unordered.some(({ source }) => count(source, original) > 1)) {
  throw new Error('Ambiguous Claude auth probe settings seam');
}
let file;
if (unordered.length === 1) {
  file = unordered[0].file;
  await writeFile(file, unordered[0].source.replace(original, fixed));
} else if (ordered.length === 1) {
  file = ordered[0].file;
} else {
  throw new Error('Claude auth probe settings seam missing; re-derive against the pinned adapter');
}
execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
process.stdout.write('>> verity-claude-acp-auth-probe: installed root settings option ordering\n');
