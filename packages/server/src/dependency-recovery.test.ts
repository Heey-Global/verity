import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { recordRecoveryHolds, readDependencyCopyObservation } from './dependency-recovery.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dependency-recovery-'));
  directories.push(root);
  const gitDir = join(root, 'git');
  mkdirSync(gitDir);
  return { root, gitDir, marker: join(gitDir, 'verity-dependencies-recovery.json') };
}

describe('dependency recovery holds', () => {
  it('keeps first observation across restart without following held links', async () => {
    const f = fixture();
    const data = join(f.root, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'patch'), 'local recovery bytes');
    const link = join(f.root, 'link');
    symlinkSync(data, link);
    const holds = [{ path: link, reason: 'Receipt is unavailable' }];
    const first = await recordRecoveryHolds(f.gitDir, holds, 1000, new AbortController().signal);
    expect(first).toEqual({
      count: 1,
      sampledBytes: lstatSync(link).blocks * 512,
      oldestObservedAt: 1000,
      complete: true,
    });
    const next = await recordRecoveryHolds(f.gitDir, holds, 100000, new AbortController().signal);
    expect(next.oldestObservedAt).toBe(1000);
    expect(readFileSync(join(data, 'patch'), 'utf8')).toBe('local recovery bytes');
  });

  it('bounds durable diagnostics and labels a partial measurement', async () => {
    const f = fixture();
    const holds = Array.from({ length: 120 }, (_, index) => ({
      path: join(f.root, 'unknown-' + index),
      reason: 'unique recovery data '.repeat(200),
    }));
    const report = await recordRecoveryHolds(f.gitDir, holds, 2000, new AbortController().signal);
    expect(report.count).toBe(120);
    expect(report.complete).toBe(false);
    expect(statSync(f.marker).size).toBeLessThanOrEqual(128 * 1024);
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({
      count: 120,
      entriesComplete: false,
    });
  });

  it('persists an incomplete hold when observation is interrupted', async () => {
    const f = fixture();
    const data = join(f.root, 'data');
    writeFileSync(data, 'unique data');
    const controller = new AbortController();
    controller.abort();
    const result = await recordRecoveryHolds(
      f.gitDir,
      [{ path: data, reason: 'changed' }],
      5000,
      controller.signal,
    );
    expect(result).toMatchObject({ count: 1, complete: false, sampledBytes: 0 });
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({ count: 1, complete: false });
    expect(readFileSync(data, 'utf8')).toBe('unique data');
  });

  it('does not follow a planted marker and never mutates a dry run', async () => {
    const f = fixture();
    const outside = join(f.root, 'outside.json');
    writeFileSync(outside, 'unchanged');
    symlinkSync(outside, f.marker);
    const holds = [{ path: outside, reason: 'local edits' }];
    await recordRecoveryHolds(f.gitDir, holds, 3000, new AbortController().signal, true);
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    await recordRecoveryHolds(f.gitDir, holds, 3000, new AbortController().signal);
    expect(readFileSync(outside, 'utf8')).toBe('unchanged');
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toMatchObject({ count: 1 });
    await recordRecoveryHolds(f.gitDir, [], 4000, new AbortController().signal);
    expect(() => statSync(f.marker)).toThrow();
  });
});

describe('untrusted dependency receipt files', () => {
  it('rejects a FIFO receipt without waiting for a writer', () => {
    const f = fixture();
    execFileSync('mkfifo', [join(f.gitDir, 'verity-dependencies-activation.json')]);
    const source = pathToFileURL(resolve('packages/server/src/dependency-recovery.ts')).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { readDependencyCopyObservation } from ${JSON.stringify(source)}; const value = await readDependencyCopyObservation(${JSON.stringify(f.gitDir)}, ${JSON.stringify(f.root)}); if (value !== undefined) process.exit(2); console.log('rejected');`,
      ],
      { encoding: 'utf8', timeout: 2000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('rejected');
  });
});

describe('dependency activation evidence', () => {
  it('projects only bounded validated admission evidence and rejects planted links', async () => {
    const f = fixture();
    const path = join(f.gitDir, 'verity-dependencies-activation.json');
    const copyAdmission = {
      availableBytes: 100,
      freeInodes: 100,
      reserveBytes: 10,
      reserveInodes: 10,
      requiredBytes: 5,
      requiredInodes: 5,
      copiedFiles: 1,
      copiedBytes: 5,
      sharingEnabled: false,
      observedAt: '2026-11-21T00:00:00.000Z',
    };
    writeFileSync(path, JSON.stringify({ copyAdmission }));
    expect(await readDependencyCopyObservation(f.gitDir, f.root)).toEqual({
      path: f.root,
      ...copyAdmission,
    });
    for (const change of [
      { copiedBytes: -1 },
      { copiedFiles: '1' },
      { observedAt: 'not a date' },
      { freeInodes: Number.MAX_VALUE },
    ]) {
      writeFileSync(path, JSON.stringify({ copyAdmission: { ...copyAdmission, ...change } }));
      expect(await readDependencyCopyObservation(f.gitDir, f.root)).toBeUndefined();
    }
    writeFileSync(path, ' '.repeat(128 * 1024 + 1));
    expect(await readDependencyCopyObservation(f.gitDir, f.root)).toBeUndefined();
    rmSync(path);
    const outside = join(f.root, 'receipt');
    writeFileSync(outside, JSON.stringify({ copyAdmission }));
    symlinkSync(outside, path);
    expect(await readDependencyCopyObservation(f.gitDir, f.root)).toBeUndefined();
  });
});
