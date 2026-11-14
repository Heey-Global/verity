import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEBT_FILE,
  baseDebt,
  compareWithBase,
  FILE_LINE_LIMIT,
  compareWithDebt,
  generatedFiles,
  lineCount,
  loweredDebt,
  oversizedFiles,
  readDebt,
} from './file-size-guard.mjs';

const ROOT = resolve(__dirname, '..');
const GUARD = join(ROOT, 'scripts/file-size-guard.mjs');

const fixtures: string[] = [];
beforeEach(() => {
  // The guard's own in-process git calls inherit this environment as well.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_')) vi.stubEnv(name, undefined);
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Fixture git runs must not reach the real repository through an inherited
// GIT_DIR or GIT_INDEX_FILE (set inside hooks), nor stall on a developer's global
// commit signing or hooks path.
const gitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A throwaway repository with the bundle script the guard reads its exclusion from. */
function fixture(files: Record<string, number>, debt: Record<string, number> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'file-size-guard-'));
  fixtures.push(root);
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write('scripts/build-runner-worker.mjs', "const outfile = 'bin/bundle.mjs';\n");
  write(DEBT_FILE, `${JSON.stringify(debt, null, 2)}\n`);
  for (const [file, lines] of Object.entries(files)) write(file, 'x\n'.repeat(lines));
  execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnv });
  execFileSync('git', ['add', '-A'], { cwd: root, env: gitEnv });
  return root;
}

/** Commits the fixture as `main`, the base the guard compares the record with. */
function commitBase(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env: gitEnv });
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  git('branch', '-M', 'main');
}

function runGuard(root: string, ...args: string[]) {
  // A copy inside the fixture, so the guard resolves the fixture as its root.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts/file-size-guard.mjs'), readFileSync(GUARD));
  return spawnSync(process.execPath, ['scripts/file-size-guard.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...gitEnv, FILE_SIZE_BASE: 'main' },
  });
}

describe('the repository', () => {
  it('finds the sources it guards', () => {
    // A filter that stopped matching would empty the scan, and the check would
    // fail only as "debt went down" — or pass, once the debt was removed.
    const found = oversizedFiles(ROOT);
    expect(Object.keys(found).length).toBeGreaterThan(0);
    expect(found['packages/server/src/server.ts']).toBeGreaterThan(0);
  });

  it('keeps every file within the limit or at its recorded size', () => {
    // On failure, follow the message: split a file that grew into modules, and
    // lower or remove the entry of one that shrank with `--update`.
    expect(compareWithDebt(oversizedFiles(ROOT), readDebt(ROOT))).toEqual([]);
  });

  it('excludes the generated runner bundle named by its build script', () => {
    const [bundle] = generatedFiles(ROOT);
    // The exclusion must still name a tracked file, or it hides nothing and a
    // renamed bundle would surface here instead of in the debt list.
    expect(execFileSync('git', ['ls-files', bundle!], { cwd: ROOT, encoding: 'utf8' })).toBe(
      `${bundle}\n`,
    );
    expect(Object.keys(readDebt(ROOT))).not.toContain(bundle);
  });

  it('runs ahead of ESLint in the full and the scoped lint entry points', () => {
    // CI selects the lint job for every source area, including the mobile app,
    // and the pre-push hook runs lint:changed; the root test suite does not run
    // for every area, so the check rides on lint.
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['lint:changed']).toMatch(/^node scripts\/file-size-guard\.mjs && /);
    const lint = readFileSync(join(ROOT, 'scripts/lint.sh'), 'utf8');
    const guard = lint.search(/^node scripts\/file-size-guard\.mjs$/m);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(lint.indexOf('lint_batched "$pkg"'));
  });
});

describe('the check', () => {
  const limit = FILE_LINE_LIMIT;

  it('accepts files at the limit and debt that matches exactly', () => {
    const root = fixture({ 'a.ts': limit, 'b.ts': limit + 10 }, { 'b.ts': limit + 10 });
    expect(runGuard(root).status).toBe(0);
  });

  it('rejects a new file above the limit', () => {
    const result = runGuard(fixture({ 'src/new.tsx': limit + 1 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/new.tsx: 1501 lines exceeds the 1500-line limit');
  });

  it('rejects growth of a recorded file', () => {
    const result = runGuard(fixture({ 'big.ts': limit + 11 }, { 'big.ts': limit + 10 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('big.ts: grew from 1510 to 1511 lines');
  });

  it('rejects a reduction that was not recorded', () => {
    const shrunk = runGuard(fixture({ 'big.ts': limit + 5 }, { 'big.ts': limit + 10 }));
    expect(shrunk.status).toBe(1);
    expect(shrunk.stderr).toContain('big.ts: shrank from 1510 to 1505 lines');
    const resolved = runGuard(fixture({ 'big.ts': limit }, { 'big.ts': limit + 10 }));
    expect(resolved.status).toBe(1);
    expect(resolved.stderr).toContain('big.ts: recorded at 1510 lines but is now within the limit');
  });

  it('rejects debt for a file that no longer exists', () => {
    const result = runGuard(fixture({}, { 'gone.ts': limit + 1 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gone.ts: recorded at 1501 lines');
  });

  it('checks new unignored files before they are committed', () => {
    const root = fixture({});
    writeFileSync(join(root, 'draft.mjs'), 'x\n'.repeat(limit + 1));
    expect(runGuard(root).status).toBe(1);
  });

  it('skips the generated bundle, vendored code and declarations, and non-source files', () => {
    const root = fixture({
      'bin/bundle.mjs': limit + 1,
      'vendor/lib/index.cjs': limit + 1,
      'types/api.d.ts': limit + 1,
      'docs/notes.md': limit + 1,
      'packages/x/src/real.cts': limit + 1,
    });
    expect(oversizedFiles(root)).toEqual({ 'packages/x/src/real.cts': limit + 1 });
  });

  it('refuses a debt record that is not a map of positive line counts', () => {
    // A hand-edited string or zero would compare as "different" forever, or not at all.
    for (const invalid of ['[]', '{"a.ts": "1600"}', '{"a.ts": 0}', '{"a.ts": 1600.5}']) {
      const root = fixture({});
      writeFileSync(join(root, DEBT_FILE), invalid);
      expect(() => readDebt(root)).toThrow(DEBT_FILE);
    }
  });

  it('rejects a record that was raised or extended since the base', () => {
    // Growing a file and its entry together would satisfy the exact comparison.
    const root = fixture({ 'big.ts': limit + 10 }, { 'big.ts': limit + 10 });
    commitBase(root);
    writeFileSync(join(root, 'big.ts'), 'x\n'.repeat(limit + 20));
    writeFileSync(join(root, 'new.ts'), 'x\n'.repeat(limit + 1));
    writeFileSync(
      join(root, DEBT_FILE),
      JSON.stringify({ 'big.ts': limit + 20, 'new.ts': limit + 1 }),
    );
    const result = runGuard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('big.ts: entry raised from 1510 to 1520');
    expect(result.stderr).toContain('new.ts: added to scripts/file-size-debt.json');
  });

  it('accepts a lowered record and skips the base comparison without a base', () => {
    const root = fixture({ 'big.ts': limit + 10 }, { 'big.ts': limit + 10 });
    commitBase(root);
    writeFileSync(join(root, 'big.ts'), 'x\n'.repeat(limit + 5));
    writeFileSync(join(root, DEBT_FILE), JSON.stringify({ 'big.ts': limit + 5 }));
    expect(runGuard(root).status).toBe(0);
    expect(baseDebt(root, 'main')).toEqual({ 'big.ts': limit + 10 });
    // A shallow checkout cannot resolve the base; the exact comparison still runs.
    expect(baseDebt(root, 'no-such-ref')).toBeUndefined();
    expect(compareWithBase({ 'a.ts': 1 }, { 'a.ts': 2 })).toEqual([]);
  });

  it('counts lines as an editor numbers them', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb')]).toEqual([
      0, 1, 1, 2,
    ]);
  });

  it('lowers and removes entries on --update but never raises or adds one', () => {
    const root = fixture(
      { 'shrunk.ts': limit + 5, 'fixed.ts': limit, 'grown.ts': limit + 20, 'new.ts': limit + 1 },
      { 'shrunk.ts': limit + 10, 'fixed.ts': limit + 10, 'grown.ts': limit + 10 },
    );
    const result = runGuard(root, '--update');
    expect(readDebt(root)).toEqual({ 'grown.ts': limit + 10, 'shrunk.ts': limit + 5 });
    // Growth and the new file still fail after the update.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('grown.ts: grew');
    expect(result.stderr).toContain('new.ts: 1501 lines exceeds');
    expect(result.stderr).not.toContain('shrunk.ts');
  });

  it('reports each problem once, in a stable order', () => {
    expect(
      compareWithDebt({ 'b.ts': limit + 2, 'a.ts': limit + 1 }, { 'c.ts': limit + 1 }),
    ).toEqual([
      expect.stringMatching(/^a\.ts: /),
      expect.stringMatching(/^b\.ts: /),
      expect.stringMatching(/^c\.ts: /),
    ]);
    expect(loweredDebt({}, { 'c.ts': limit + 1 })).toEqual({});
  });
});
