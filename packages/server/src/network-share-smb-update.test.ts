import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NetworkShareError, SmbClient, contentVersion } from './network-share-smb.js';

/** A step of the fake share's plan, by the 1-based number of the command across all runs. */
type Fault =
  | { at: number; drop: 'before' | 'after'; stayDown?: true }
  | { at: number; create: string; content: string };

/**
 * A stand-in smbclient over a local folder. It understands the commands the
 * client sends and can drop the connection or let "someone else" create a file
 * at a chosen command, so the recovery paths of an update can be driven
 * deterministically. Serialized into an executable; it must stay self-contained.
 */
function fakeSmbclient(): void {
  // Works whether the script runs as CommonJS or, under a "type": "module"
  // package.json above the temporary folder, as an ES module.
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const root = process.env.FAKE_ROOT!;
  const state = process.env.FAKE_STATE!;
  const plan = JSON.parse(process.env.FAKE_PLAN ?? '[]') as Fault[];
  const say = (text: string) => process.stderr.write(`${text}\n`);
  if (fs.existsSync(path.join(state, 'down'))) {
    say('do_connect: Connection to nas failed (Error NT_STATUS_HOST_UNREACHABLE)');
    process.exit(1);
  }
  const counter = path.join(state, 'count');
  const local = (remote: string) => path.join(root, ...remote.split('\\').filter(Boolean));
  const lines = fs.readFileSync(0, 'utf8').split('\n');
  for (const line of lines) {
    const [command] = line.split(' ');
    const args = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]!);
    if (command === 'quit') process.exit(0);
    if (line.includes('verity-mark')) {
      say(`NT_STATUS_OBJECT_NAME_NOT_FOUND getting alt name for ${args[0]}`);
      continue;
    }
    if (!command) continue;
    const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0') + 1;
    fs.writeFileSync(counter, String(count));
    const faults = plan.filter((fault) => fault.at === count);
    const drop = (when: 'before' | 'after') => {
      const fault = faults.find((item) => 'drop' in item && item.drop === when);
      if (!fault) return;
      if ('stayDown' in fault && fault.stayDown) fs.writeFileSync(path.join(state, 'down'), '');
      process.exit(1);
    };
    drop('before');
    const missing = () => say('NT_STATUS_OBJECT_NAME_NOT_FOUND');
    if (command === 'allinfo') {
      const target = local(args[0]!);
      if (!fs.existsSync(target)) missing();
      else if (fs.statSync(target).isDirectory()) say('attributes:  (10)');
      else say(`attributes:  (80)\nstream: [::$DATA], ${fs.statSync(target).size} bytes`);
    } else if (command === 'put') fs.copyFileSync(args[0]!, local(args[1]!));
    else if (command === 'get') {
      if (fs.existsSync(local(args[0]!))) fs.copyFileSync(local(args[0]!), args[1]!);
      else missing();
    } else if (command === 'rename') {
      const [from, to] = [local(args[0]!), local(args[1]!)];
      if (!fs.existsSync(from)) missing();
      else if (fs.existsSync(to)) say('NT_STATUS_OBJECT_NAME_COLLISION');
      else fs.renameSync(from, to);
    } else if (command === 'del') {
      if (fs.existsSync(local(args[0]!))) fs.unlinkSync(local(args[0]!));
      else missing();
    }
    for (const fault of faults)
      if ('create' in fault) fs.writeFileSync(local(fault.create), fault.content);
    drop('after');
  }
}

const target = {
  host: 'nas',
  port: null,
  share: 'team',
  username: 'u',
  password: Buffer.from('p'),
};
const original = Buffer.from('original text\n');
const replacement = Buffer.from('new text\n');

// The commands of an update, in order: 1 allinfo, 2 put temporary, 3 rename the
// file aside, 4 get the moved file, 5 rename temporary into place, 6 del aside.
// A restore then runs: rename aside back, del temporary.
const MOVE_ASIDE = 3;
const DOWNLOAD = 4;
const PUBLISH = 5;

let dir: string;
let root: string;
let binary: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verity-fake-share-'));
  root = join(dir, 'share');
  mkdirSync(root);
  mkdirSync(join(dir, 'state'));
  binary = join(dir, 'smbclient');
  writeFileSync(binary, `#!/usr/bin/env node\n(${fakeSmbclient.toString()})();\n`);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, 'notes.md'), original);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function update(plan: Fault[], expected = contentVersion(original)): Promise<unknown> {
  const client = new SmbClient({
    binary,
    timeoutMs: 20_000,
    env: {
      FAKE_ROOT: root,
      FAKE_STATE: join(dir, 'state'),
      FAKE_PLAN: JSON.stringify(plan),
    },
  });
  return client.update(target, 'notes.md', replacement, expected).catch((error: unknown) => error);
}

function code(error: unknown): string | undefined {
  expect(error).toBeInstanceOf(NetworkShareError);
  return (error as NetworkShareError).code;
}

/** The share's entries and their content, hidden names grouped by kind. */
function share(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(root)) {
    const key = /^\.verity-.*\.(old|tmp)$/.exec(name)?.[1] ?? name;
    expect(entries[key], `two ${key} entries`).toBeUndefined();
    entries[key] = readFileSync(join(root, name), 'utf8');
  }
  return entries;
}

// Each case is a way the replace can be cut short. Whatever happens, the
// original's bytes must stay somewhere on the share, and the agent must be told
// where when they are not under the file's own name; an error that hides a
// moved original invites a fresh write over the gap.
describe('replacing a file on a share', () => {
  it('replaces the file and leaves nothing behind', async () => {
    expect(await update([])).toMatchObject({ version: contentVersion(replacement) });
    expect(share()).toEqual({ 'notes.md': 'new text\n' });
  });

  it('puts the original back when its content changed since it was read', async () => {
    expect(code(await update([], contentVersion(Buffer.from('older'))))).toBe('conflict');
    expect(share()).toEqual({ 'notes.md': 'original text\n' });
  });

  it('puts the original back after the connection dropped before publishing', async () => {
    expect(code(await update([{ at: PUBLISH, drop: 'before' }]))).toBe('unreachable');
    expect(share()).toEqual({ 'notes.md': 'original text\n' });
  });

  it('keeps the file someone created meanwhile and the original under a hidden name', async () => {
    const error = await update([{ at: DOWNLOAD, create: 'notes.md', content: 'theirs\n' }]);
    expect(code(error)).toBe('restore_failed');
    expect((error as Error).message).toContain('.verity-….old');
    expect(share()).toEqual({ 'notes.md': 'theirs\n', old: 'original text\n' });
  });

  it('keeps the original hidden when a conflict cannot be put back', async () => {
    const error = await update(
      [{ at: DOWNLOAD, create: 'notes.md', content: 'theirs\n' }],
      contentVersion(Buffer.from('older')),
    );
    expect(code(error)).toBe('restore_failed');
    expect(share()).toEqual({ 'notes.md': 'theirs\n', old: 'original text\n' });
  });

  it('says the original may be hidden when the share stays out of reach', async () => {
    const error = await update([{ at: MOVE_ASIDE, drop: 'after', stayDown: true }]);
    expect(code(error)).toBe('interrupted');
    expect((error as Error).message).toContain('.verity-….old');
    expect(share()).toEqual({ old: 'original text\n', tmp: 'new text\n' });
  });

  // From outside, a drop just before the move looks like one just after it;
  // the warning must err on the side of the original having moved.
  it('warns the same way when the share drops right before the move', async () => {
    expect(code(await update([{ at: MOVE_ASIDE, drop: 'before', stayDown: true }]))).toBe(
      'interrupted',
    );
    expect(share()).toEqual({ 'notes.md': 'original text\n', tmp: 'new text\n' });
  });
});
