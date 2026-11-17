import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { shareDependencyFiles } from './dependency-sharing.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const identity = 'b'.repeat(64);
function fixture(sealed = true, marker = sealed) {
  const root = mkdtempSync(join(tmpdir(), 'verity-sharing-'));
  dirs.push(root);
  const inventory = join(root, '.git', 'verity-dependencies', identity);
  const central = join(inventory, 'node_modules');
  const worktree = join(root, '.verity-sessions', 's');
  const modules = join(worktree, 'node_modules');
  const file = (base: string, path: string, contents: string, mode: number) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), contents);
    chmodSync(join(base, path), mode);
  };
  for (const [path, contents] of [
    ['dep/index.js', 'shared'],
    ['dep/edited.js', 'original'],
    ['dep/node_modules/nested/index.js', 'nested'],
    ['.package-lock.json', '{}'],
  ] as const) {
    file(central, path, contents, sealed ? 0o444 : 0o644);
    // Same size as the original: only the bytes tell the edit apart.
    file(modules, path, path === 'dep/edited.js' ? 'origin@l' : contents, 0o644);
  }
  file(central, 'dep/cli.js', 'cli', sealed ? 0o555 : 0o755);
  // Same bytes, different execute bits: not the same file.
  file(modules, 'dep/cli.js', 'cli', 0o644);
  file(modules, 'dep/local-only.js', 'local', 0o644);
  // A command target identical to the inventory's: npm would reset its mode.
  file(central, 'dep/bin.js', 'bin', sealed ? 0o555 : 0o755);
  file(modules, 'dep/bin.js', 'bin', 0o755);
  mkdirSync(join(modules, '.bin'));
  symlinkSync('../dep/bin.js', join(modules, '.bin', 'dep'));
  file(modules, '.verity-install.json', JSON.stringify({ identity }), 0o644);
  if (marker) writeFileSync(join(inventory, 'sealed'), 'v1');
  return { root, worktree, central, modules };
}
const inode = (path: string) => statSync(path).ino;

// Root sessions keep their copies: root ignores read-only files.
describe.skipIf(process.getuid?.() === 0)(
  'sharing private dependency copies with the central inventory',
  () => {
    it('links only byte-identical files and leaves every other file alone', async () => {
      const f = fixture();
      const result = await shareDependencyFiles(f.root, f.worktree, new AbortController().signal);
      expect(result.files).toBe(2);
      expect(result.bytes).toBeGreaterThan(0);
      for (const path of ['dep/index.js', 'dep/node_modules/nested/index.js'])
        expect(inode(join(f.modules, path))).toBe(inode(join(f.central, path)));
      // An edit, an unknown file, a mode difference, a command target and npm's
      // in-place receipt stay private.
      for (const path of [
        'dep/edited.js',
        'dep/local-only.js',
        'dep/cli.js',
        'dep/bin.js',
        '.package-lock.json',
      ])
        expect(statSync(join(f.modules, path)).nlink).toBe(1);
      expect(readFileSync(join(f.modules, 'dep/edited.js'), 'utf8')).toBe('origin@l');
      const again = await shareDependencyFiles(f.root, f.worktree, new AbortController().signal);
      expect(again.files).toBe(0);
    });
    it('shares nothing from an inventory that is not sealed', async () => {
      // Writable files, or read-only ones a seal does not vouch for yet.
      for (const f of [fixture(false), fixture(true, false)]) {
        const result = await shareDependencyFiles(f.root, f.worktree, new AbortController().signal);
        expect(result.files).toBe(0);
        expect(statSync(join(f.modules, 'dep/index.js')).nlink).toBe(1);
      }
    });
    it('shares nothing through a node_modules that is a link to another tree', async () => {
      const f = fixture();
      const elsewhere = join(f.root, 'elsewhere');
      renameSync(f.modules, elsewhere);
      symlinkSync(elsewhere, f.modules);
      const result = await shareDependencyFiles(f.root, f.worktree, new AbortController().signal);
      expect(result.files).toBe(0);
      expect(statSync(join(elsewhere, 'dep/index.js')).nlink).toBe(1);
    });
    it('leaves a tree alone that its session made private', async () => {
      const f = fixture();
      writeFileSync(join(f.modules, '.verity-private'), '');
      const result = await shareDependencyFiles(f.root, f.worktree, new AbortController().signal);
      expect(result.files).toBe(0);
      expect(statSync(join(f.modules, 'dep/index.js')).nlink).toBe(1);
    });
    it('counts without linking in dry-run mode', async () => {
      const f = fixture();
      const result = await shareDependencyFiles(
        f.root,
        f.worktree,
        new AbortController().signal,
        true,
      );
      expect(result.files).toBe(2);
      expect(statSync(join(f.modules, 'dep/index.js')).nlink).toBe(1);
    });
    it('stops at its budget without touching the remaining files', async () => {
      const f = fixture();
      const controller = new AbortController();
      controller.abort();
      await expect(shareDependencyFiles(f.root, f.worktree, controller.signal)).rejects.toThrow();
      expect(statSync(join(f.modules, 'dep/index.js')).nlink).toBe(1);
    });
  },
);
