// A stand-in smbclient over a local folder, for driving SmbClient through
// dropped connections and concurrent writers without a Samba server.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SmbClient, type SmbTarget } from './network-share-smb.js';

export type Fault =
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
    } else if (command === 'mkdir') {
      if (fs.existsSync(local(args[0]!))) say('NT_STATUS_OBJECT_NAME_COLLISION');
      else fs.mkdirSync(local(args[0]!));
    } else if (command === 'rmdir') {
      const target = local(args[0]!);
      if (!fs.existsSync(target)) missing();
      else if (!fs.statSync(target).isDirectory()) say('NT_STATUS_NOT_A_DIRECTORY');
      else if (fs.readdirSync(target).length > 0) say('NT_STATUS_DIRECTORY_NOT_EMPTY');
      else fs.rmdirSync(target);
    } else if (command === 'del') {
      if (fs.existsSync(local(args[0]!))) fs.unlinkSync(local(args[0]!));
      else missing();
    }
    for (const fault of faults)
      if ('create' in fault) fs.writeFileSync(local(fault.create), fault.content);
    drop('after');
  }
}

export const FAKE_TARGET: SmbTarget = {
  host: 'nas',
  port: null,
  share: 'team',
  username: 'u',
  password: Buffer.from('p'),
};

export interface FakeShare {
  /** The share's root folder on disk. */
  root: string;
  /** A client whose smbclient follows `plan`; command numbers count across its runs. */
  client(plan?: Fault[]): SmbClient;
  /**
   * The share's entries by path, folders as `/`. Hidden `.verity-…` names are
   * keyed by their kind (`old`, `tmp`) in place of the random part.
   */
  entries(): Record<string, string>;
  remove(): void;
}

export function createFakeShare(): FakeShare {
  const dir = mkdtempSync(join(tmpdir(), 'verity-fake-share-'));
  const root = join(dir, 'share');
  mkdirSync(root);
  mkdirSync(join(dir, 'state'));
  const binary = join(dir, 'smbclient');
  writeFileSync(binary, `#!/usr/bin/env node\n(${fakeSmbclient.toString()})();\n`);
  chmodSync(binary, 0o755);
  return {
    root,
    client: (plan = []) =>
      new SmbClient({
        binary,
        timeoutMs: 20_000,
        env: { FAKE_ROOT: root, FAKE_STATE: join(dir, 'state'), FAKE_PLAN: JSON.stringify(plan) },
      }),
    entries: () => {
      const entries: Record<string, string> = {};
      const walk = (folder: string, prefix: string) => {
        for (const name of readdirSync(folder).sort()) {
          const full = join(folder, name);
          const key = prefix + (/^\.verity-.*\.(old|tmp)$/.exec(name)?.[1] ?? name);
          if (Object.hasOwn(entries, key)) throw new Error(`two ${key} entries`);
          if (statSync(full).isDirectory()) {
            entries[key] = '/';
            walk(full, `${key}/`);
          } else entries[key] = readFileSync(full, 'utf8');
        }
      };
      walk(root, '');
      return entries;
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
