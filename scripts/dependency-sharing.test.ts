import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { env, fixture, helper } from './dependency-fixture.js';

const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });
const identities = (root: string) =>
  readdirSync(join(root, '.git', 'verity-dependencies')).filter((name) =>
    /^[a-f0-9]{64}$/u.test(name),
  );
// Root ignores permission bits, so a write check proves nothing there.
const enforcesModes = process.getuid?.() !== 0;

// Root copies instead of sharing: its writes would ignore read-only files.
describe.skipIf(!enforcesModes)('dependency files shared between sessions', () => {
  it('links package files read-only and keeps top-level receipts private', () => {
    const f = fixture();
    const sibling = f.sibling();
    for (const directory of [f.worktree, sibling])
      writeFileSync(join(directory, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    const second = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(second.status, second.stderr).toBe(0);
    const [identity] = identities(f.root);
    const central = join(f.root, '.git', 'verity-dependencies', identity!, 'node_modules');
    const manifest = (root: string) => statSync(join(root, 'private', 'package.json'));
    // A copy instead of a link would keep every session's full installation.
    expect(manifest(join(f.worktree, 'node_modules')).ino).toBe(manifest(central).ino);
    expect(manifest(join(sibling, 'node_modules')).ino).toBe(manifest(central).ino);
    expect(manifest(central).mode & 0o222).toBe(0);
    expect(() =>
      writeFileSync(join(f.worktree, 'node_modules', 'private', 'package.json'), '{}'),
    ).toThrow(/EACCES/u);
    expect(
      readFileSync(join(sibling, 'node_modules', 'private', 'package.json'), 'utf8'),
    ).toContain('2.0.0');
    // npm resets a command target's mode whenever it links commands; a shared
    // target would turn writable for every session and withdraw the inventory.
    const command = statSync(join(f.worktree, 'node_modules', 'private', 'cli.js'));
    expect(command.nlink).toBe(1);
    expect(command.mode & 0o200).toBe(0o200);
    // npm rewrites its hidden lockfile in place; a shared one would fail every npm run.
    const receipt = statSync(join(f.worktree, 'node_modules', '.package-lock.json'));
    expect(receipt.nlink).toBe(1);
    expect(receipt.mode & 0o200).toBe(0o200);
  });
  it('keeps a session working after its central inventory is retired', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    rmSync(join(f.root, '.git', 'verity-dependencies', identities(f.root)[0]!), {
      recursive: true,
    });
    expect(
      readFileSync(join(f.worktree, 'node_modules', 'private', 'package.json'), 'utf8'),
    ).toContain('1.0.0');
    expect(f.run('status').status).toBe(0);
    // Retiring the inventory changes the files' status time; that is no edit,
    // so the unchanged tree is still discarded on the next identity change.
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    const preserved = join(f.root, '.git', 'worktrees', 'test', 'verity-dependencies-preserved');
    expect(existsSync(preserved) ? readdirSync(preserved) : []).toEqual([]);
  });
  it('keeps a replaced tree even when the new file looks read-only and old', () => {
    // A patch unpacked with preserved times and modes is still a local edit.
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    const file = join(f.worktree, 'node_modules', 'private', 'package.json');
    const { atime, mtime } = statSync(file);
    rmSync(file);
    writeFileSync(file, '{"version":"1.0.1"}');
    chmodSync(file, 0o444);
    utimesSync(file, atime, mtime);
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    expect(f.run('install').status).toBe(0);
    const preserved = join(f.root, '.git', 'worktrees', 'test', 'verity-dependencies-preserved');
    expect(
      readdirSync(preserved).map((copy) =>
        readFileSync(join(preserved, copy, 'private', 'package.json'), 'utf8'),
      ),
    ).toEqual(['{"version":"1.0.1"}']);
  });
  it('makes shared files private on request without touching the inventory', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    const result = f.run('install', {}, '--private');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Made [1-9][0-9]* shared dependency files private/u);
    const file = join(f.worktree, 'node_modules', 'private', 'package.json');
    expect(statSync(file).nlink).toBe(1);
    // Storage collection must not link the private copies back.
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-private'))).toBe(true);
    writeFileSync(file, '{"version":"patched"}');
    const central = join(
      f.root,
      '.git',
      'verity-dependencies',
      identities(f.root)[0]!,
      'node_modules',
      'private',
      'package.json',
    );
    expect(readFileSync(central, 'utf8')).toContain('1.0.0');
    expect(statSync(central).mode & 0o222).toBe(0);
    // A private file is the session's own; a later install leaves it alone.
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('patched');
  });
  it('makes files writable on request once their inventory is retired', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    rmSync(join(f.root, '.git', 'verity-dependencies', identities(f.root)[0]!), {
      recursive: true,
    });
    // Unshared but still read-only: patching would fail without this.
    const result = f.run('install', {}, '--private');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Made [1-9][0-9]* shared dependency files private/u);
    const file = join(f.worktree, 'node_modules', 'private', 'package.json');
    writeFileSync(file, '{"version":"patched"}');
    expect(readFileSync(file, 'utf8')).toContain('patched');
  });
  it('withdraws an inventory whose shared file was made writable and keeps the edit', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    expect(f.run('install').status).toBe(0);
    const file = join(f.worktree, 'node_modules', 'private', 'package.json');
    chmodSync(file, 0o644);
    writeFileSync(file, '{"version":"edited"}');
    // The edit went through the shared inode: the inventory carries it too and
    // must never be linked into another session again.
    const failed = f.run('install');
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(/central inventory was withdrawn/u);
    expect(identities(f.root)).toEqual([]);
    // Now unshared, the edit is this session's own, like any local edit.
    expect(f.run('install').status).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('{"version":"edited"}');
    const sibling = f.sibling();
    writeFileSync(join(sibling, 'package-lock.json'), lock('1.0.0'));
    const fresh = spawnSync(process.execPath, [helper, 'install'], {
      cwd: sibling,
      env: { ...env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(fresh.status, fresh.stderr).toBe(0);
    const clean = join(sibling, 'node_modules', 'private', 'package.json');
    expect(readFileSync(clean, 'utf8')).toContain('1.0.0');
    expect(statSync(clean).mode & 0o222).toBe(0);
  }, 120_000);
  it('copies files a filesystem cannot link and reports it', () => {
    const f = fixture();
    const preload = join(f.root, 'bin', 'no-links.mjs');
    writeFileSync(
      preload,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.linkSync = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
syncBuiltinESMExports();
`,
    );
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('1.0.0'));
    const result = f.run('install', { NODE_OPTIONS: `--import=${preload}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Copied [1-9][0-9]* dependency files that could not be shared/u);
    const file = join(f.worktree, 'node_modules', 'private', 'package.json');
    expect(statSync(file).nlink).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('1.0.0');
  });
});
