import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
type Step = {
  name?: string;
  uses?: string;
  with?: Record<string, string | number>;
  run?: string;
  if?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Job = { needs?: string[]; steps?: Step[]; env?: Record<string, string> };
const workflow = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as { jobs: Record<string, Job> };

describe('release build caches', () => {
  it('keys compiler bytes on every compilation input and verifies their hashes', () => {
    const steps = workflow('release').jobs['prepare-server-build-context'].steps ?? [];
    const cache = steps.find((step) => step.name === 'Cache script sandbox compiler outputs');
    const compiler = steps.find((step) => step.name === 'Build attested script sandbox artifacts');
    const script = readFileSync('scripts/build-script-sandbox-prebuilts.sh', 'utf8');
    const dockerfile = readFileSync('features/verity-sandbox-toolkit/prebuilt/Dockerfile', 'utf8');
    for (const source of [...dockerfile.matchAll(/^COPY (\S+) /gm)]
      .map((match) => match[1])
      .filter((source) => !source.startsWith('--'))) {
      expect(cache?.with?.key).toContain(`features/verity-sandbox-toolkit/${source}`);
    }
    expect(script).toContain('prebuilt');
    expect(cache?.with?.key).toContain('prebuilt/Dockerfile');
    expect(cache?.with?.key).toContain('scripts/build-script-sandbox-prebuilts.sh');
    expect(compiler?.if).toContain("cache-hit != 'true'");
    expect(steps.find((step) => step.name === 'Verify restored compiler outputs')?.run).toContain(
      'sha256sum --check --strict',
    );
  });

  it('limits dependency cache export time without failing publication', () => {
    const steps = workflow('release').jobs['build-server'].steps ?? [];
    const cache = steps.find((step) => step.name === 'Cache Server build dependencies');
    expect(cache?.with?.target).toBe('builder-deps');
    expect(cache?.['timeout-minutes']).toBe(2);
    expect(cache?.['continue-on-error']).toBe(true);
    expect(cache?.with?.['cache-to']).toContain('mode=min');
    expect(readFileSync('deploy/Dockerfile', 'utf8')).toContain('FROM builder-deps AS builder');
  });
});
