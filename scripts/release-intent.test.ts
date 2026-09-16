import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const validator = resolve('.github/scripts/validate-release-intent');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), 'verity-release-intent-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.name', 'Verity Test');
  git(cwd, 'config', 'user.email', 'test@verity.invalid');
  await writeFile(join(cwd, 'source.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '--quiet', '-m', 'chore: base');
  return { cwd, base: git(cwd, 'rev-parse', 'HEAD') };
}

async function addIntent(cwd: string, train: 'backend' | 'none', name = 'decision.md') {
  const directory = join(cwd, '.release', train, 'intents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), 'This change belongs to the selected train.\n');
}

function validate(cwd: string, base: string, author = 'contributor') {
  const head = git(cwd, 'rev-parse', 'HEAD');
  return spawnSync(validator, [base, head, author], { cwd, encoding: 'utf8' });
}

describe('backend release intent policy', () => {
  it.each(['backend', 'none'] as const)('accepts one append-only %s decision', async (train) => {
    const { cwd, base } = await repository();
    await addIntent(cwd, train);
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'fix: classified change');

    expect(validate(cwd, base).status).toBe(0);
  });

  it('rejects a missing or ambiguous decision', async () => {
    const { cwd, base } = await repository();
    await writeFile(join(cwd, 'source.txt'), 'changed\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'fix: unclassified change');
    expect(validate(cwd, base).status).not.toBe(0);

    await addIntent(cwd, 'backend', 'backend.md');
    await addIntent(cwd, 'none', 'none.md');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'chore: ambiguous intents');
    expect(validate(cwd, base).status).not.toBe(0);
  });

  it('rejects edits and deletions of the append-only ledger', async () => {
    const { cwd } = await repository();
    await addIntent(cwd, 'backend');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'fix: original decision');
    const base = git(cwd, 'rev-parse', 'HEAD');
    await writeFile(
      join(cwd, '.release/backend/intents/decision.md'),
      'Reclassified after review.\n',
    );
    git(cwd, 'add', '.');
    git(cwd, 'commit', '--quiet', '-m', 'chore: rewrite decision');

    expect(validate(cwd, base).status).not.toBe(0);
  });

  // Verity authors real product changes through a GitHub App. A blanket bot
  // exemption lets those changes merge green but never enter Release Please.
  it.each(['verity-fcgzv6b1[bot]', 'another-agent[bot]'])(
    'requires an explicit decision from %s',
    async (author) => {
      const { cwd, base } = await repository();
      await writeFile(join(cwd, 'source.txt'), 'product fix\n');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '--quiet', '-m', 'fix(server): product fix');
      expect(validate(cwd, base, author).status).not.toBe(0);

      await addIntent(cwd, 'backend');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '--quiet', '-m', 'fix(server): declare release');
      expect(validate(cwd, base, author).status).toBe(0);
    },
  );

  it.each(['renovate[bot]', 'github-actions[bot]'])(
    'exempts known automation %s',
    async (author) => {
      const { cwd, base } = await repository();
      await writeFile(join(cwd, 'source.txt'), 'generated\n');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '--quiet', '-m', 'chore: generated update');

      expect(validate(cwd, base, author).status).toBe(0);
    },
  );
});
