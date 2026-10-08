import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
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
type Job = { if?: string; needs?: string[]; steps?: Step[]; env?: Record<string, string> };
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

  it('isolates cache writes from recovery checkouts and scopes them to the exact main push', () => {
    const { jobs } = workflow('release');
    const prepare = jobs['prepare-server-build-context'];
    const save = jobs['save-script-sandbox-cache'];
    const restore = prepare.steps?.find(
      (step) => step.name === 'Cache script sandbox compiler outputs',
    );
    expect(restore?.uses).toContain('actions/cache/restore@');
    expect(
      prepare.steps?.some((step) => /^actions\/cache(?:@|\/save@)/.test(step.uses ?? '')),
    ).toBe(false);
    expect(save.steps?.some((step) => step.run || step.uses?.startsWith('actions/checkout@'))).toBe(
      false,
    );
    expect(save.steps?.some((step) => step.uses?.startsWith('actions/cache/save@'))).toBe(true);
    expect(save.needs).toContain('prepare-server-build-context');
    expect(save.if).toBeDefined();
    expect(save['continue-on-error']).toBe(true);
    const verifier = prepare.steps?.find(
      (step) => step.name === 'Verify restored compiler outputs',
    );
    expect(verifier?.run).toContain(
      'chmod 0755 linux-amd64/verity-script-sandbox linux-arm64/verity-script-sandbox',
    );
    for (const [event, ref, candidate, hit, expected] of [
      ['push', 'refs/heads/main', 'current', 'false', true],
      ['workflow_dispatch', 'refs/heads/main', 'current', 'false', false],
      ['push', 'refs/heads/feature', 'current', 'false', false],
      ['push', 'refs/heads/main', 'older', 'false', false],
      ['push', 'refs/heads/main', 'current', 'true', false],
    ] as const) {
      const values = {
        'github.event_name': event,
        'github.ref': ref,
        'github.sha': 'current',
        'needs.release-please.outputs.backend-sha': candidate,
        'needs.prepare-server-build-context.outputs.compiler-cache-hit': hit,
      };
      let expression = save.if ?? 'false';
      for (const [name, value] of Object.entries(values))
        expression = expression.replaceAll(name, JSON.stringify(value));
      expect(runInNewContext(expression), `${event}/${ref}/${candidate}/${hit}`).toBe(expected);
    }
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
