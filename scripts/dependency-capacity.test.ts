import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture } from './dependency-fixture.js';

const storage = resolve('agent-seed/bin/verity-dependency-storage.mjs');
function probe(code: string, args: string[] = []) {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import * as s from ${JSON.stringify('file://' + storage)};\n${code}`,
      ...args,
    ],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}
const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });

describe('dependency copy capacity admission', () => {
  it('protects the byte and inode reserves and fails closed for unknown capacity', () => {
    expect(
      probe(`
      const reserve=10*1024**3;
      const growth={bytes:8192,inodes:3};
      for (const disk of [{bavail:reserve+8191,bsize:1,ffree:2000000},{bavail:reserve+8192,bsize:1,ffree:1000002},{bavail:NaN,bsize:1,ffree:2000000}]) {
        try { s.admitCopy('.',growth,{},disk); console.log('admitted'); }
        catch(error) { console.log(error.message.split(':')[0]); }
      }
      s.admitCopy('.',growth,{}, {bavail:reserve+8192,bsize:1,ffree:1000003});
      console.log('boundary admitted');
    `)
        .trim()
        .split('\n'),
    ).toEqual([
      'Dependency capacity admission rejected',
      'Dependency capacity admission rejected',
      'Dependency capacity is unknown; no additional copy admitted.',
      'boundary admitted',
    ]);
  });

  it('counts hard-linked recovery blocks once, budgets every copied name and never follows links', () => {
    const f = fixture();
    const tree = join(f.worktree, 'inventory');
    mkdirSync(tree);
    writeFileSync(join(tree, 'file'), Buffer.alloc(8192, 1));
    linkSync(join(tree, 'file'), join(tree, 'alias'));
    symlinkSync('/unreadable-foreign-path', join(tree, 'outside'));
    const result = JSON.parse(
      probe(`console.log(JSON.stringify(s.measureTrees([process.argv[1]])));`, [tree]),
    ) as { bytes: number; allocatedBytes: number; inodes: number };
    expect(result.inodes).toBe(4);
    expect(result.bytes).toBeGreaterThan(result.allocatedBytes);
    expect(result.allocatedBytes).toBe(
      statSync(tree).blocks * 512 +
        statSync(join(tree, 'file')).blocks * 512 +
        lstatSync(join(tree, 'outside')).blocks * 512,
    );
    expect(() => probe(`s.measureTrees([process.argv[1]],{entries:2});`, [tree])).toThrow(
      /inventory is incomplete/u,
    );
  });

  it('rejects a copy before replacing an active installation when reserve is unavailable', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    const result = f.run('install', { VERITY_BUILD_FREE_GIB: '999999' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Dependency capacity admission rejected');
    expect(existsSync(join(f.worktree, 'node_modules'))).toBe(false);
    expect(existsSync(f.called)).toBe(false);
  });

  it('records measured copy accounting and checks private copies before marking a tree', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    const installed = f.run('install');
    expect(installed.status, installed.stderr).toBe(0);
    const record = JSON.parse(
      readFileSync(join(f.root, '.git/worktrees/test/verity-dependencies-activation.json'), 'utf8'),
    ) as {
      copyAdmission: {
        requiredBytes: number;
        copiedBytes: number;
        copiedFiles: number;
        reserveBytes: number;
        reserveInodes: number;
      };
    };
    expect(record.copyAdmission.requiredBytes).toBeGreaterThanOrEqual(
      record.copyAdmission.copiedBytes,
    );
    expect(record.copyAdmission.copiedFiles).toBeGreaterThan(0);
    expect(record.copyAdmission.reserveBytes).toBe(10 * 1024 ** 3);
    expect(record.copyAdmission.reserveInodes).toBe(1_000_000);
    const refused = f.run('install', { VERITY_BUILD_FREE_GIB: '999999' }, '--private');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Dependency capacity admission rejected');
    expect(existsSync(join(f.worktree, 'node_modules', '.verity-private'))).toBe(false);
    expect(
      readFileSync(join(f.worktree, 'node_modules', 'private', 'package.json'), 'utf8'),
    ).toContain('2.0.0');
  });

  it('admits a larger new identity using the requested replacement footprint', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    const initial = f.run('install');
    expect(initial.status, initial.stderr).toBe(0);
    writeFileSync(join(f.worktree, 'node_modules', 'patch'), Buffer.alloc(64 * 1024, 1));
    const preserved = join(f.root, '.git/worktrees/test/verity-dependencies-preserved');
    mkdirSync(join(preserved, 'existing'), { recursive: true });
    writeFileSync(join(preserved, 'existing', 'patch'), Buffer.alloc(64 * 1024, 2));
    // This identity has not been prepared: its larger allowance is only known after npm.
    const packages = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `node_modules/dependency${index}`,
        { version: '3.0.0' },
      ]),
    );
    writeFileSync(
      join(f.worktree, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
    const result = f.run('install');
    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(f.worktree, 'node_modules/dependency99/package.json'), 'utf8'),
    ).toContain('3.0.0');
    const recovery = readdirSync(preserved).filter((name) => name !== 'existing');
    expect(recovery).toHaveLength(1);
    expect(readFileSync(join(preserved, recovery[0]!, 'patch')).length).toBe(64 * 1024);
    expect(readFileSync(join(preserved, 'existing', 'patch')).length).toBe(64 * 1024);
  });

  it('pauses additional replacement when recovery consumes its measured allowance', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    const initial = f.run('install');
    expect(initial.status, initial.stderr).toBe(0);
    const active = join(f.worktree, 'node_modules');
    writeFileSync(join(active, 'patch'), 'unique active edit');
    const preserved = join(f.root, '.git/worktrees/test/verity-dependencies-preserved');
    mkdirSync(join(preserved, 'existing'), { recursive: true });
    writeFileSync(join(preserved, 'existing', 'patch'), Buffer.alloc(1024 * 1024, 1));
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('3.0.0'));
    const result = f.run('install');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Dependency recovery budget exceeded');
    // An unknown replacement must be prepared before its recovery allowance is known.
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
    expect(readFileSync(join(active, 'patch'), 'utf8')).toBe('unique active edit');
    expect(readdirSync(preserved)).toEqual(['existing']);
    expect(readFileSync(join(preserved, 'existing', 'patch')).length).toBe(1024 * 1024);
  });
});
