import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('supplies only self mappings without exposing peer procfs or project writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'verity-self-maps-'));
  try {
    const project = join(root, 'project');
    const runtime = join(root, 'runtime');
    mkdirSync(project);
    mkdirSync(runtime);
    const helper = join(root, 'sandbox');
    const fixture = join(project, 'fixture');
    execFileSync('gcc', [
      '-O2',
      '-Wall',
      '-Wextra',
      resolve('features/verity-sandbox-toolkit/bin/verity-script-sandbox.c'),
      '-o',
      helper,
    ]);
    execFileSync('gcc', ['-O2', resolve('scripts/fixtures/self-proc-maps.c'), '-o', fixture]);
    const original = join(project, 'keep');
    const state = join(runtime, 'state');
    writeFileSync(original, 'original');
    const args = [
      '--root',
      project,
      '--cwd',
      project,
      '--loading',
      'dynamic',
      '--dynamic-root',
      runtime,
      '--read-only-root',
    ];
    const run = (extra: string[]) =>
      spawnSync(helper, [...args, ...extra, '--', fixture, original, state], {
        encoding: 'utf8',
        timeout: 20_000,
      });
    const protectedRun = run(['--self-proc-maps']);
    expect(protectedRun.status, protectedRun.stderr || String(protectedRun.error)).toBe(0);
    expect(readFileSync(original, 'utf8')).toBe('original');
    expect(readFileSync(state, 'utf8')).toBe('runtime');
    expect(protectedRun.stdout).toMatch(/verified/);
    // The procfs exception must be necessary on the kernel path used by Docker.
    if (protectedRun.stdout.startsWith('landlock:')) {
      const control = run([]);
      expect(control.status, control.stderr).toBe(11);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
