import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = {
  needs?: unknown;
  concurrency?: unknown;
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
const dispatch = parse(readFileSync('.github/workflows/release-dispatch.yml', 'utf8')) as {
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

describe('release tag ordering', () => {
  it('reserves tags before the publication queue without inheriting its lock', () => {
    const registration = dispatch.jobs['register-release-tags'];
    expect(registration).toBeDefined();
    // A registration job inside either queue restores the historical-tag race.
    expect(dispatch.concurrency).toBeUndefined();
    expect(registration.needs).toBeUndefined();
    expect(registration.concurrency).toBeUndefined();
    expect(registration.if).toBeUndefined();
    expect(dispatch.jobs['release-train'].needs).toBe('register-release-tags');
    expect(registration.permissions).toEqual({ contents: 'write', 'pull-requests': 'read' });
    const reserve = registration.steps?.find((step) =>
      step.run?.includes('release-tag-registration.mjs'),
    );
    expect(reserve?.run).toContain('register "$RELEASE_HEAD"');
    expect(reserve?.if).toContain("github.event_name == 'push'");
    expect(reserve?.if).toContain('inputs.reconcile');
  });

  it('reports the barrier on both ordinary and bot-dispatched PR checks', () => {
    expect(ci.on.pull_request).toBeDefined();
    expect(ci.on.workflow_dispatch).toBeDefined();
    const barrier = ci.jobs['release-tag-barrier'];
    expect(barrier.if).toBeUndefined();
    expect(barrier.needs).toBeUndefined();
    expect(barrier.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    const step = barrier.steps?.find((step) => step.run?.includes('release-tag-registration.mjs'));
    expect(step?.if).toBe("github.event_name != 'push'");
    expect(step?.run).toContain('git diff --quiet --no-renames "$base" HEAD -- .github/workflows');
    expect(step?.run).toContain('check "$base"');
    expect(step?.run).toContain('set -euo pipefail');
  });
});

describe('workflow merge barrier execution', () => {
  it.each(['ordinary', 'workflow', 'renamed workflow'])(
    'checks %s changes against the immutable base',
    (change) => {
      const cwd = mkdtempSync(join(tmpdir(), 'verity-tag-barrier-'));
      try {
        const git = (...args: string[]) =>
          execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        git('init', '-q');
        git('config', 'user.email', 'test@example.com');
        git('config', 'user.name', 'Test');
        mkdirSync(join(cwd, '.github/workflows'), { recursive: true });
        writeFileSync(join(cwd, '.github/workflows/test.yml'), 'original');
        git('add', '.');
        git('commit', '-qm', 'base');
        const base = git('rev-parse', 'HEAD');
        if (change === 'renamed workflow') git('mv', '.github/workflows/test.yml', 'moved.txt');
        else
          writeFileSync(
            join(cwd, change === 'workflow' ? '.github/workflows/test.yml' : 'ordinary.txt'),
            'changed',
          );
        git('add', '.');
        git('commit', '-qm', 'change');
        mkdirSync(join(cwd, 'bin'));
        // A failed tag check must block every workflow change, including renames.
        const node = join(cwd, 'bin/node');
        writeFileSync(
          node,
          '#!/bin/sh\n[ "$1" = scripts/release-tag-registration.mjs ] && [ "$2" = check ] && [ "$3" = "$PR_BASE" ] || exit 99\nexit 42\n',
        );
        chmodSync(node, 0o755);
        const step = ci.jobs['release-tag-barrier'].steps?.find((step) =>
          step.run?.includes('release-tag-registration.mjs'),
        );
        expect(step?.run).toBeDefined();
        const result = spawnSync('bash', ['-c', step!.run!], {
          cwd,
          env: { ...process.env, PR_BASE: base, PATH: `${join(cwd, 'bin')}:${process.env.PATH}` },
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(change === 'ordinary' ? 0 : 42);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
