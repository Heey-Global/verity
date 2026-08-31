import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// `createTestDb` resolves to one shared PostgreSQL in CI (see
// packages/store/src/testing.ts). That database is reached over a socket, which
// makes it incompatible with fake timers: `vi.advanceTimersByTimeAsync` flushes
// microtasks and fires timers, but a real connection needs event-loop turns for
// its socket I/O, so a query issued by the advanced tick may still be in flight
// when the assertion after it runs. Under pglite the same code resolves in
// microtasks and always wins that race.
//
// The failure is therefore timing-dependent: it does not reproduce reliably, and
// it surfaces as an unrelated-looking "Number of calls: 0" in CI. This check
// turns that into a deterministic local failure instead.
function testFiles(): string[] {
  return readdirSync('packages')
    .map((pkg) => join('packages', pkg, 'src'))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.test.ts'))
        .map((entry) => join(dir, entry)),
    );
}

describe('test database harness', () => {
  const files = testFiles().map((path) => ({ path, source: readFileSync(path, 'utf8') }));

  it('scans the suite it is meant to guard', () => {
    // A scan that silently matches nothing would make every assertion below pass
    // forever, so pin both that files are found and that the shared helper is
    // actually in use somewhere.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some(({ source }) => /\bcreateTestDb\b/.test(source))).toBe(true);
    expect(files.some(({ source }) => /\buseFakeTimers\b/.test(source))).toBe(true);
  });

  it('keeps fake-timer files off the shared PostgreSQL harness', () => {
    const offenders = files
      .filter(({ source }) => /\bcreateTestDb\b/.test(source) && /\buseFakeTimers\b/.test(source))
      .map(({ path }) => path);

    expect(
      offenders,
      'These files drive database work under fake timers, which the shared ' +
        'PostgreSQL harness cannot satisfy — advanceTimersByTimeAsync does not ' +
        'await socket I/O. Use createIsolatedTestDb() (in-process pglite) instead.',
    ).toEqual([]);
  });
});
