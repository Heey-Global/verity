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
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixture } from './dependency-fixture.js';

const storage = resolve('agent-seed/bin/verity-dependency-storage.mjs');
function probe(code: string, args: string[] = [], environment: NodeJS.ProcessEnv = process.env) {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import * as s from ${JSON.stringify('file://' + storage)};\n${code}`,
      ...args,
    ],
    { encoding: 'utf8', stdio: 'pipe', env: environment },
  );
}
const lock = (version: string) =>
  JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/private': { version } } });

describe('dependency copy capacity admission', () => {
  it('checks the reserve on every actual destination and reports the lowest measurements', () => {
    expect(
      probe(`
      const reserve=10*1024**3;
      const disks={git:{bavail:reserve+100000,bsize:1,ffree:2000000},tree:{bavail:reserve+8191,bsize:1,ffree:1000003}};
      try { s.admitCopyDestinations(['git','tree'],{bytes:8192,inodes:3},{},path=>disks[path]); }
      catch(error) { console.log(error.message.split(':')[0]); }
      disks.tree.bavail++;
      const result=s.admitCopyDestinations(['git','tree'],{bytes:8192,inodes:3},{},path=>disks[path]);
      console.log(result.availableBytes===reserve+8192 && result.freeInodes===1000003);
      try { s.admitCopyDestinations([],{bytes:0,inodes:0}); }
      catch(error) { console.log(error.message); }
    `)
        .trim()
        .split('\n'),
    ).toEqual([
      'Dependency capacity admission rejected',
      'true',
      'Dependency copy destinations are unknown; no additional copy admitted.',
    ]);
  });

  it('checks a private tree filesystem before marking or copying its packages', () => {
    const f = fixture();
    writeFileSync(join(f.worktree, 'package-lock.json'), lock('2.0.0'));
    const installed = f.run('install');
    expect(installed.status, installed.stderr).toBe(0);
    const modules = join(f.worktree, 'node_modules');
    const preload = join(f.root, 'capacity-probe.mjs');
    writeFileSync(
      preload,
      `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=fs.statfsSync;
      fs.statfsSync=(path,...args)=>path===${JSON.stringify(modules)}
        ? {...original(path,...args),ffree:0} : original(path,...args);
      syncBuiltinESMExports();
    `,
    );
    const refused = f.run('install', { NODE_OPTIONS: `--import=${preload}` }, '--private');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('Dependency capacity admission rejected');
    expect(existsSync(join(modules, '.verity-private'))).toBe(false);
    expect(readFileSync(join(modules, 'private', 'package.json'), 'utf8')).toContain('2.0.0');
  });

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
      probe(`console.log(JSON.stringify(await s.measureTrees([process.argv[1]])));`, [tree]),
    ) as { bytes: number; allocatedBytes: number; inodes: number };
    expect(result.inodes).toBe(4);
    expect(result.bytes).toBeGreaterThan(result.allocatedBytes);
    expect(result.allocatedBytes).toBe(
      statSync(tree).blocks * 512 +
        statSync(join(tree, 'file')).blocks * 512 +
        lstatSync(join(tree, 'outside')).blocks * 512,
    );
    const withinBudget = JSON.parse(
      probe(
        `console.log(JSON.stringify(s.measureTrees([process.argv[1]], {
        recoveryBudget: {remaining: ${result.allocatedBytes}, added: 0, budget: ${result.allocatedBytes}}
      })));`,
        [tree],
      ),
    ) as typeof result;
    expect(withinBudget).toEqual(result);
    expect(() => probe(`await s.measureTrees([process.argv[1]],{entries:2});`, [tree])).toThrow(
      /inventory is incomplete/u,
    );
  });

  it('refuses a proven recovery overflow before reaching the traversal cap', () => {
    const f = fixture();
    const tree = join(f.worktree, 'over-budget');
    const content = Buffer.alloc(8192, 1);
    writeFileSync(tree, content);
    const tail = join(f.worktree, 'beyond-cap');
    writeFileSync(tail, 'preserved tail');
    const allocated = statSync(tree).blocks * 512;
    expect(allocated).toBeGreaterThan(0);
    expect(() =>
      probe(
        `s.measureTrees([process.argv[1], process.argv[2]], {
        entries: 1, phase: 'retained recovery trees',
        recoveryBudget: {remaining: 0, added: 4096, budget: 4096}
      });`,
        [tree, tail],
      ),
    ).toThrow(
      `Dependency recovery budget exceeded: at least ${allocated} retained bytes plus 4096 newly preserved bytes exceed the 4096-byte measured installation allowance.`,
    );
    expect(readFileSync(tree)).toEqual(content);
    expect(readFileSync(tail, 'utf8')).toBe('preserved tail');
  });

  it('finishes metadata traversal when per-file Node calls would exhaust the deadline', () => {
    const f = fixture();
    const tree = join(f.worktree, 'slow-metadata');
    mkdirSync(tree);
    for (let index = 0; index < 30; index++)
      writeFileSync(join(tree, `file-${index}\nwith-newline`), 'content');
    const preload = join(f.root, 'slow-metadata.mjs');
    writeFileSync(
      preload,
      `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original = fs.lstatSync;
      const clock = Date.now;
      let delay = 0;
      fs.lstatSync = (...args) => { delay += 1000; return original(...args); };
      Date.now = () => clock() + delay;
      syncBuiltinESMExports();
    `,
    );
    const result = JSON.parse(
      probe(
        `
      console.log(JSON.stringify(s.measureTrees([process.argv[1]])));
    `,
        [tree],
        {
          ...process.env,
          NODE_OPTIONS: '--import=' + pathToFileURL(preload).href,
        },
      ),
    ) as { inodes: number; bytes: number };
    expect(result.inodes).toBe(31);
    expect(result.bytes).toBeGreaterThanOrEqual(31 * 4096);
  });

  it('reports the measurement phase and refuses incomplete scans', () => {
    const f = fixture();
    const tree = join(f.worktree, 'bounded-metadata');
    mkdirSync(tree);
    writeFileSync(join(tree, 'file'), 'content');
    expect(() =>
      probe(
        `await s.measureTrees([process.argv[1]], {
      entries: 1, phase: 'cache activation'
    });`,
        [tree],
      ),
    ).toThrow(/cache activation: entry limit 1 exceeded after 2 entries/u);
    expect(() =>
      probe(
        `await s.measureTrees([process.argv[1]], {
      milliseconds: 0, phase: 'retained recovery trees'
    });`,
        [tree],
      ),
    ).toThrow(/retained recovery trees: time limit 0 ms reached/u);
  });

  it.each(['entry cap', 'timeout', 'failed exit', 'filesystem boundary'])(
    'stops a running scanner and refuses partial metadata on %s',
    (failure) => {
      const f = fixture();
      const tree = join(f.worktree, 'partial-metadata');
      mkdirSync(tree);
      const stat = statSync(tree);
      const line = `${failure === 'filesystem boundary' ? stat.dev + 1 : stat.dev} ${stat.ino} ${stat.size} ${stat.blocks} d\n`;
      const source =
        `process.stdout.write(${JSON.stringify(line.repeat(failure === 'entry cap' ? 2 : 1))});` +
        (failure === 'failed exit'
          ? 'process.stderr.write("find: blocked-path: Permission denied\\n"); process.exitCode = 1;'
          : 'setInterval(() => {}, 1000);');
      const marker = join(f.root, 'scanner-closed');
      const preload = join(f.root, 'scanner-preload.mjs');
      writeFileSync(
        preload,
        `
        import childProcess from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        import {writeFileSync} from 'node:fs';
        const original = childProcess.spawn;
        childProcess.spawn = (_file, _args, options) => {
          const scanner = original(process.execPath, ['-e', ${JSON.stringify(source)}], options);
          ${
            failure === 'timeout'
              ? `scanner.stdout.once('data', () => {
            const clock = Date.now;
            Date.now = () => clock() + 10000;
          });`
              : ''
          }
          scanner.on('close', (code, signal) => writeFileSync(${JSON.stringify(marker)}, String(code === 1 || signal === 'SIGKILL')));
          return scanner;
        };
        syncBuiltinESMExports();
      `,
      );
      const output = probe(
        `
        import {readFileSync} from 'node:fs';
        process.env.NODE_OPTIONS = ${JSON.stringify('--import=' + pathToFileURL(preload).href)};
        try {
          s.measureTrees([process.argv[1]], {
            entries: 1, milliseconds: 10000, phase: 'cache activation'
          });
          console.log('unexpected admission');
        } catch (error) {
          console.log(error.message);
          console.log(readFileSync(${JSON.stringify(marker)}, 'utf8'));
        }
      `,
        [tree],
      );
      const reason =
        failure === 'entry cap'
          ? 'entry limit 1 exceeded after 2 entries'
          : failure === 'timeout'
            ? 'time limit 10000 ms reached after 1 entries'
            : 'metadata traversal failed';
      expect(output).toContain(
        failure === 'filesystem boundary'
          ? 'Dependency capacity inventory crosses a filesystem.'
          : `cache activation: ${reason}`,
      );
      if (failure === 'failed exit')
        expect(output).toContain('find: blocked-path: Permission denied');
      expect(output.trim().endsWith('true')).toBe(true);
    },
  );

  it.each([true, false])(
    'requires GNU timeout when the default implementation is incompatible (available: %s)',
    (available) => {
      const output = probe(`
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const original = childProcess.spawnSync;
      const calls = [];
      childProcess.spawnSync = (file, args, options) => {
        calls.push([file, args]);
        if (args[0] === '--version') return {status: 0, stdout:
          file === '/usr/bin/gnutimeout' && ${available} ? 'timeout (GNU coreutils) 9.7' : 'timeout (uutils coreutils) 0.10.0'};
        return original(process.execPath, ['-e', 'console.log(JSON.stringify({bytes:0,inodes:0,allocatedBytes:0}))'], options);
      };
      syncBuiltinESMExports();
      try { s.measureTrees([]); console.log(calls.at(-1)[0]); }
      catch (error) { console.log(error.message); }
    `);
      expect(output.trim()).toBe(
        available
          ? '/usr/bin/gnutimeout'
          : 'Dependency capacity inventory requires GNU timeout; no additional copy admitted.',
      );
    },
  );

  it('stops the scanner when its measurement worker cannot run cleanup', async () => {
    const f = fixture();
    const tree = join(f.worktree, 'stalled-worker');
    mkdirSync(tree);
    const scannerPid = join(f.root, 'scanner-pid');
    const preload = join(f.root, 'stalled-preload.mjs');
    const stat = statSync(tree);
    const line = `${stat.dev} ${stat.ino} ${stat.size} ${stat.blocks} d\n`;
    const source = `require('node:fs').writeFileSync(${JSON.stringify(scannerPid)}, String(process.pid)); process.stdout.write(${JSON.stringify(line)}); setInterval(() => {}, 1000);`;
    writeFileSync(
      preload,
      `
      import childProcess from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      const original = childProcess.spawn;
      childProcess.spawn = (_file, _args, options) => {
        const scanner = original(process.execPath, ['-e', ${JSON.stringify(source)}], options);
        scanner.stdout.once('data', () => process.kill(process.pid, 'SIGSTOP'));
        return scanner;
      };
      syncBuiltinESMExports();
    `,
    );
    expect(() =>
      probe(
        `
      process.env.NODE_OPTIONS = ${JSON.stringify('--import=' + pathToFileURL(preload).href)};
      s.measureTrees([process.argv[1]], {milliseconds: 5000});
    `,
        [tree],
      ),
    ).toThrow(/measurement process failed/u);
    const pid = readFileSync(scannerPid, 'utf8');
    await expect
      .poll(
        () => {
          try {
            const state = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1]![0];
            return ['Z', 'X'].includes(state!);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
            throw error;
          }
        },
        { interval: 10, timeout: 2000 },
      )
      .toBe(true);
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
    // Large recovery histories must still activate a larger prepared replacement.
    for (let index = 0; index < 10_000; index++)
      writeFileSync(join(preserved, 'existing', `empty-${index}`), '');
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
    expect(readdirSync(join(preserved, 'existing'))).toHaveLength(10_001);
  }, 60_000);

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
    expect(result.stderr).toContain('Dependency recovery budget exceeded: at least ');
    // An unknown replacement must be prepared before its recovery allowance is known.
    expect(readFileSync(f.called, 'utf8').match(/\nci\n/g)).toHaveLength(2);
    expect(readFileSync(join(active, 'patch'), 'utf8')).toBe('unique active edit');
    expect(readdirSync(preserved)).toEqual(['existing']);
    expect(readFileSync(join(preserved, 'existing', 'patch')).length).toBe(1024 * 1024);
  });
});
