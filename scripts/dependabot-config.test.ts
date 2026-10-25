import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';

const config = parse(readFileSync('.github/dependabot.yml', 'utf8')) as {
  version: number;
  updates: Array<{
    'package-ecosystem': string;
    directory: string;
    'open-pull-requests-limit': number;
    'target-branch'?: string;
    'commit-message': { prefix: string };
  }>;
};

// Security PRs otherwise fail before dependency compatibility checks can run.
it('produces security update titles accepted by the release gate', () => {
  expect(config.version).toBe(2);
  expect(config.updates).toHaveLength(1);
  for (const update of config.updates) {
    expect(update['package-ecosystem']).toBe('npm');
    expect(update.directory).toBe('/');
    // A non-default target branch prevents these settings applying to security updates.
    expect(update['target-branch']).toBeUndefined();
    const prefix = update['commit-message'].prefix;
    const separator = /[\w)\]]$/.test(prefix) ? ': ' : ' ';
    const result = spawnSync(
      resolve('.github/scripts/validate-release-title'),
      [`${prefix}${separator}Bump compression from 1.8.1 to 1.8.2`],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  }
});

// Enabling version updates would silently duplicate Renovate's update PRs.
it('keeps regular version updates disabled', () => {
  for (const update of config.updates) {
    expect(update['open-pull-requests-limit']).toBe(0);
  }
});
