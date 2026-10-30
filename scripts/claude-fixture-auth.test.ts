import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(
  [
    'scripts/fixtures/fake-claude-recreate-smoke.mjs',
    'scripts/fixtures/fake-claude-live-smoke.mjs',
    'scripts/probes/claude-cli-mcp-fixture.mjs',
  ].flatMap((fixture) => ['none', 'before', 'after'].map((settings) => ({ fixture, settings }))),
)(
  'answers auth probes without entering a session ($fixture, settings=$settings)',
  ({ fixture, settings }) => {
    const root = mkdtempSync(join(tmpdir(), 'claude-fixture-auth-'));
    try {
      const result = spawnSync(
        process.execPath,
        [
          resolve(fixture),
          ...(settings === 'before' ? ['--settings', '{"apiKeyHelper":""}'] : []),
          'auth',
          'status',
          '--json',
          ...(settings === 'after' ? ['--settings', '{"apiKeyHelper":""}'] : []),
        ],
        {
          env: { PATH: process.env.PATH, VERITY_LIVE_SMOKE_WORKTREE: root },
          encoding: 'utf8',
          timeout: 3000,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ loggedIn: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
