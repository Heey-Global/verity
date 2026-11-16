import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync('deploy/bin/verity-self-update-live-smoke', 'utf8');
const orchestration = source.slice(
  source.indexOf('run_smoke_passes() {'),
  source.indexOf("repo='ghcr.io/"),
);

function run(
  profile = 'full',
  failedPass = '',
  fixture = '',
  override = 'false',
  previousImage = fixture ? 'candidate:image' : 'released:image',
  previousTag = fixture ? 'HEAD' : 'v1.0.0',
) {
  const root = mkdtempSync(join(tmpdir(), 'self-update-passes-'));
  const log = join(root, 'calls');
  const driver = join(root, 'driver');
  writeFileSync(log, '');
  writeFileSync(
    driver,
    `#!/usr/bin/env bash
set -eu
printf '%s|%s\\n' "$VERITY_SMOKE_PROFILE" "$*" >> "$CALL_LOG"
if [[ "$VERITY_SMOKE_PROFILE" == "$FAILED_PASS" ]]; then exit 17; fi
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\n${orchestration.replace('run_smoke_passes "${BASH_SOURCE[0]}"', 'run_smoke_passes "$DRIVER"')}`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          image: 'candidate:image',
          previous_image: previousImage,
          previous_tag: previousTag,
          smoke_profile: profile,
          fixture_mode: fixture,
          VERITY_SMOKE_ALLOW_NO_ROLLBACK: override,
          DRIVER: driver,
          CALL_LOG: log,
          FAILED_PASS: failedPass,
        },
      },
    );
    return { result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('live self-update smoke passes', () => {
  it('proves the real release transition before running every fault on the candidate fixture', () => {
    const { result, calls } = run();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([
      'release|candidate:image released:image v1.0.0',
      'full|candidate:image candidate:image HEAD --rollback-fixture',
    ]);
  });

  it('stops on a failed release transition rather than replacing it with a passing fixture', () => {
    const { result, calls } = run('full', 'release');
    expect(result.status).toBe(17);
    expect(calls).toEqual(['release|candidate:image released:image v1.0.0']);
  });

  it('propagates a failure in the rollback matrix', () => {
    const { result, calls } = run('full', 'full');
    expect(result.status).toBe(17);
    expect(calls).toHaveLength(2);
  });

  it('does not recurse or expand a release-only run or an explicit override', () => {
    for (const [profile, fixture, override] of [
      ['release', '', 'false'],
      ['full', '--rollback-fixture', 'false'],
      ['full', '', 'true'],
    ]) {
      const { result, calls } = run(profile, '', fixture, override);
      expect(result.status, result.stderr).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a rollback fixture with a released image or another Compose revision', () => {
    for (const [image, revision] of [
      ['released:image', 'HEAD'],
      ['candidate:image', 'v1.0.0'],
    ]) {
      const { result, calls } = run('full', '', '--rollback-fixture', 'false', image, revision);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('rollback fixture requires the candidate image');
      expect(calls).toEqual([]);
    }
  });

  it('keeps orchestration behind daemon identity and emptiness guards and before cleanup ownership', () => {
    const dispatch = source.indexOf('run_smoke_passes "${BASH_SOURCE[0]}"');
    expect(dispatch).toBeGreaterThan(
      source.indexOf('[[ "$host_daemon_id" != "$isolated_daemon_id" ]]'),
    );
    expect(dispatch).toBeGreaterThan(source.indexOf('[[ "$adopted_networks" == 0 ]]'));
    expect(dispatch).toBeLessThan(source.indexOf('trap cleanup EXIT'));
  });
});
