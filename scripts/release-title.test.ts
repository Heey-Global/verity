import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const validator = resolve('.github/scripts/validate-release-title');
const validate = (title: string) => spawnSync(validator, [title], { encoding: 'utf8' });

describe('release title input', () => {
  it('rechecks titles after edits and passes them as data rather than shell code', () => {
    const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
      on: { pull_request: { types: string[] } };
      jobs: {
        changes: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> };
      };
    };
    expect(workflow.on.pull_request.types).toContain('edited');
    const step = workflow.jobs.changes.steps.find(
      (entry) => entry.name === 'Validate Conventional Commit title',
    );
    expect(step?.env?.PR_TITLE).toBe('${{ github.event.pull_request.title }}');
    expect(step?.run).toContain('"$PR_TITLE"');
    expect(step?.run).not.toContain('github.event.pull_request.title');
  });
  it.each([
    'fix(server): reject stale tokens',
    'feat(mobile): show recovery',
    'test(release): automate acceptance',
    'chore(main): release server 0.14.0',
    'perf(store): reduce writes',
    'feat!: remove obsolete API',
    'refactor(server)!: replace persisted protocol',
    'ci: reduce duplicate work',
    'build(deps): update compiler',
    'docs: clarify pairing',
    'style: format source',
    'revert: restore previous behavior',
  ])('accepts %s without any repository intent file', (title) => {
    expect(validate(title).status).toBe(0);
  });

  // An unparseable squash title can merge successfully but never produce the
  // intended version bump; do not silently exempt bot-authored product changes.
  it.each([
    '',
    'Fix server',
    'fix: ',
    'fix(server) change',
    'unknown: change',
    'fix: one\nfeat: two',
  ])('rejects an unparseable release input: %j', (title) => {
    const result = validate(title);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Conventional Commit');
  });
});
