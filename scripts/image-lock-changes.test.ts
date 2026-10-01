import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { dependencyGraphChanged } from './image-lock-changes.mjs';

const lock = (packages: Record<string, object>) => ({ lockfileVersion: 3, packages });
const base = lock({
  '': { devDependencies: { typescript: '1' } },
  'packages/session': { dependencies: { '@verity/events': '*', sdk: '1' } },
  'node_modules/@verity/events': { link: true, resolved: 'packages/events' },
  'packages/events': { dependencies: { nested: '1' } },
  'node_modules/sdk': { version: '1', peerDependencies: { peer: '1' } },
  'node_modules/peer': { version: '1' },
  'node_modules/nested': { version: '1', integrity: 'original' },
  'node_modules/typescript': { version: '1' },
  'node_modules/sharp': { version: '1' },
});
const roots = ['', 'packages/session'];

describe('image dependency ownership', () => {
  it('ignores changes outside the complete installed graph', () => {
    const head = structuredClone(base);
    head.packages['node_modules/sharp'] = { version: '2' };
    expect(dependencyGraphChanged(base, head, roots)).toBe(false);
  });

  it.each(['node_modules/nested', 'node_modules/typescript', 'node_modules/peer'])(
    'retains changes to transitive, tooling and peer packages: %s',
    (key) => {
      const head = structuredClone(base);
      head.packages[key] = { version: '2' };
      expect(dependencyGraphChanged(base, head, roots)).toBe(true);
    },
  );

  it('retains source-pin changes without a version bump', () => {
    const head = structuredClone(base);
    head.packages['node_modules/nested'] = { version: '1', integrity: 'changed' };
    expect(dependencyGraphChanged(base, head, roots)).toBe(true);
  });

  it('resolves dependencies relative to linked workspace targets', () => {
    const before = structuredClone(base);
    before.packages['packages/events/node_modules/nested'] = { version: '1' };
    const head = structuredClone(before);
    head.packages['packages/events/node_modules/nested'] = { version: '2' };
    expect(dependencyGraphChanged(before, head, roots)).toBe(true);
  });

  it('retains removals and rejects incomplete required graphs', () => {
    const head = structuredClone(base);
    delete head.packages['node_modules/nested'];
    expect(() => dependencyGraphChanged(base, head, roots)).toThrow('Missing dependency');
    expect(() => dependencyGraphChanged({ lockfileVersion: 2 }, base, roots)).toThrow();
  });

  it('runs checks when git evidence is unavailable', () => {
    expect(
      execFileSync('node', ['scripts/image-lock-changes.mjs', 'missing-ref', 'HEAD', 'relay'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    ).toBe('true');
  });
});

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

describe('image dependency routing', () => {
  it.each(['project-relay', 'verity-sandbox'])(
    'requires successful classification before skipping %s',
    (name) => {
      const { jobs } = workflow(name);
      expect(jobs['architecture-smoke'].needs).toContain('dependency-changes');
      expect(jobs['smoke-test'].needs).toContain('dependency-changes');
      const run = jobs['smoke-test'].steps?.[0].run;
      expect(run).toContain('test "$CLASSIFICATION_RESULT" = success');
      expect(run).toContain('test "$ARCHITECTURE_SMOKE_RESULT" = skipped');
      expect(run).toContain('test "$ARCHITECTURE_SMOKE_RESULT" = success');
    },
  );
});
