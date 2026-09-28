import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/pending-release-trains.mjs');

function select(
  diff: Partial<Record<'backend' | 'mobile' | 'website', string>>,
  pending: string[],
) {
  const cwd = mkdtempSync(join(tmpdir(), 'pending-release-trains-'));
  mkdirSync(join(cwd, 'bin'));
  const log = join(cwd, 'gh.log');
  writeFileSync(
    join(cwd, 'bin/gh'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const joined = process.argv.slice(2).join(' ');
appendFileSync(process.env.TRAINS_LOG, joined + '\\n');
if (!joined.includes('--paginate') || !joined.includes('/pulls?')) throw new Error('unexpected gh invocation: ' + joined);
const rows = JSON.parse(process.env.TRAINS_PENDING).map((component, index) => ({
  number: 100 + index, merged_at: '2026-09-28T21:35:05Z', merge_commit_sha: 'a'.repeat(40),
  user: { login: 'github-actions[bot]' }, head: { ref: 'release-please--branches--main--components--' + component }, labels: ['autorelease: pending'] }));
process.stdout.write(rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
`,
    { mode: 0o755 },
  );
  const output = join(cwd, 'output');
  writeFileSync(output, '');
  const result = spawnSync(process.execPath, [script], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'fixture/repo',
      GITHUB_OUTPUT: output,
      TRAINS_LOG: log,
      TRAINS_PENDING: JSON.stringify(pending),
      DIFF_BACKEND: diff.backend ?? '',
      DIFF_MOBILE: diff.mobile ?? '',
      DIFF_WEBSITE: diff.website ?? '',
    },
  });
  const queries = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length
    : 0;
  return { ...result, output: readFileSync(output, 'utf8'), queries };
}

describe('pending publication train selection', () => {
  it('keeps the trains a push diff selected', () => {
    const result = select({ backend: 'true', mobile: 'false', website: 'true' }, []);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('backend=true\nmobile=false\nwebsite=true\n');
    expect(result.queries).toBe(1);
  });

  it('adds every train whose merged release PR is still unpublished', () => {
    // The break this guards: a mobile release merge selected only itself while
    // the overtaken server release merge had handed its publication to it, so
    // server 2.16.0 stayed unpublished with both runs green.
    const result = select({ backend: 'false', mobile: 'true', website: 'false' }, ['server']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('backend=true\nmobile=true\nwebsite=false\n');
    expect(result.stdout).toContain('::notice::backend: release PR #100 is merged and unpublished');
  });

  it('selects only pending trains when there is no push diff', () => {
    const result = select({}, ['mobile', 'website']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('backend=false\nmobile=true\nwebsite=true\n');
  });

  it('requires an output file', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    expect(result.status).not.toBe(0);
  });
});
