import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it } from 'vitest';

type Step = { name?: string; id?: string; run?: string };
const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { needs?: string | string[]; steps: Step[] }>;
};
const fast = workflow.jobs.changes!.steps.find((step) => step.id === 'classify')!.run!;
const gate = workflow.jobs['ci-checks']!.steps.find(
  (step) => step.name === 'Verify all required jobs succeeded',
)!.run!;
const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ci-fast-'));
  temporary.push(directory);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(directory, 'source.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  git('mv', 'source.ts', 'moved.ts');
  git('commit', '-qm', 'fixture rename');
  return { directory, git, base };
}

it.each(['opened', 'synchronize', 'edited'])(
  'classifies %s locally and counts both rename paths',
  (action) => {
    const { directory, git, base } = fixture();
    const output = join(directory, 'output');
    const result = spawnSync('bash', ['-c', fast], {
      cwd: directory,
      env: {
        ...process.env,
        EVENT_NAME: 'pull_request',
        EVENT_ACTION: action,
        PR_BASE: base,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).toBe(0);
    const values = readFileSync(output, 'utf8');
    expect(values).toContain(`tree=${git('rev-parse', 'HEAD^{tree}')}`);
    expect(values).toContain(`event_kind=pull_request:${action}`);
    expect(values).toContain('path_count=2');
  },
);

it('fails classification on a real diff error instead of publishing empty evidence', () => {
  const { directory, base } = fixture();
  const output = join(directory, 'output');
  const result = spawnSync(
    'bash',
    ['-c', fast.replace('git diff --no-renames', 'git diff --invalid-option --no-renames')],
    {
      cwd: directory,
      env: { ...process.env, EVENT_NAME: 'pull_request', PR_BASE: base, GITHUB_OUTPUT: output },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  expect(result.status).not.toBe(0);
});

it.each(['changes', 'resolve-check-plan'])(
  'the required gate rejects %s failure even with no selected jobs',
  (failed) => {
    const script = gate.replace(
      /\$\{\{ needs\.([^}]+) \}\}/g,
      (_match: string, reference: string) => {
        if (reference.includes('.outputs.')) return 'false';
        return reference === `${failed}.result` ? 'failure' : 'success';
      },
    );
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`${failed} did not succeed`);
  },
);

it('refuses resolving checks against a different checkout tree', () => {
  const { directory } = fixture();
  const binding = workflow.jobs['resolve-check-plan']!.steps.find(
    (step) => step.name === 'Bind check plan to classified checkout',
  )!.run!;
  const result = spawnSync('bash', ['-c', binding], {
    cwd: directory,
    env: { ...process.env, CLASSIFIED_TREE: 'f'.repeat(40) },
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(result.status).not.toBe(0);
});
