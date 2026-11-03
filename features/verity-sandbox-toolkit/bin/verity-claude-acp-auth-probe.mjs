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
const file = path.join(root, 'dist', 'acp-agent.js');
const source = await readFile(file, 'utf8');
const original = 'args.push("--settings", JSON.stringify(context.override));';
const fixed = 'args.unshift("--settings", JSON.stringify(context.override));';
if (source.includes(original)) {
  if (source.indexOf(original) !== source.lastIndexOf(original)) {
    throw new Error('Ambiguous Claude auth probe settings seam');
  }
  await writeFile(file, source.replace(original, fixed));
} else if (!source.includes(fixed)) {
  throw new Error('Claude auth probe settings seam missing; re-derive against the pinned adapter');
}
execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
process.stdout.write('>> verity-claude-acp-auth-probe: installed root settings option ordering\n');
