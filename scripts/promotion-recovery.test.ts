import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseRecoveryReceipt, promotionInputs } from './promotion-recovery.mjs';

const helper = resolve('scripts/promotion-recovery.mjs');
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'promotion-recovery-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const write = (path: string, contents: string) => {
    mkdirSync(resolve(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  write('apps/mobile/ota-promotion.json', JSON.stringify({ version: '1.0.1', runtime: '1.0.0' }));
  write('.github/workflows/mobile-ota-promote.yml', 'name: fixture\n');
  write('scripts/mobile-ota-release.ts', '// initial publisher\n');
  const commit = () => {
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'test');
    return git('rev-parse', 'HEAD');
  };
  const identity = (ref = 'HEAD', kind = 'ota') =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {promotionIdentity} from ${JSON.stringify(helper)};console.log(JSON.stringify(promotionIdentity(${JSON.stringify(kind)},${JSON.stringify(ref)})));`,
        ],
        { cwd, encoding: 'utf8' },
      ),
    ) as { candidate: string; pipeline: string; manifest: { version: string } };
  return { cwd, git, write, commit, identity };
}

describe('promotion retry identity', () => {
  it('changes only for the approved candidate or relevant pipeline Git objects', () => {
    const f = fixture();
    const old = f.commit();
    const first = f.identity();
    f.write('product.txt', 'ordinary product change');
    f.commit();
    expect(f.identity()).toEqual(first);
    f.write('scripts/mobile-ota-release.ts', '// fixed publisher');
    f.commit();
    const fixed = f.identity();
    expect(fixed.candidate).toBe(first.candidate);
    expect(fixed.pipeline).not.toBe(first.pipeline);
    expect(f.identity(old)).toEqual(first);
    f.write('scripts/prepare-mobile-eas-build.mjs', '// install fix');
    f.commit();
    expect(f.identity().pipeline).not.toBe(fixed.pipeline);
    f.write(
      'apps/mobile/package.json',
      JSON.stringify({ name: 'mobile', scripts: { postinstall: 'node fix.mjs' } }),
    );
    f.commit();
    expect(f.identity().pipeline).not.toBe(fixed.pipeline);
    const dependencyFixed = f.identity();
    f.write(
      'apps/mobile/ota-promotion.json',
      JSON.stringify({ version: '1.0.2', runtime: '1.0.0' }),
    );
    f.commit();
    expect(f.identity().candidate).not.toBe(first.candidate);
    expect(f.identity().pipeline).toBe(dependencyFixed.pipeline);
  });
  it.each(['server', 'native'] as const)(
    'does not reset %s recovery for unused npm dependencies',
    (kind) => {
      const f = fixture();
      f.write(
        kind === 'server' ? 'releases/server-production.json' : 'releases/mobile-production.json',
        JSON.stringify({ version: '1.0.0' }),
      );
      f.write(`.github/workflows/${promotionInputs[kind].workflow}`, 'name: fixture');
      f.commit();
      const first = f.identity('HEAD', kind);
      f.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
      f.commit();
      expect(f.identity('HEAD', kind)).toEqual(first);
      f.write('scripts/capture-json.mjs', '// relevant imported helper fix');
      f.commit();
      expect(f.identity('HEAD', kind).pipeline).not.toBe(first.pipeline);
    },
  );
  it('prevents a stale queued recovery from invoking publication', () => {
    const f = fixture();
    f.commit();
    const first = f.identity();
    const output = join(f.cwd, 'output');
    const invoke = (candidate: string, pipeline: string) => {
      writeFileSync(output, '');
      execFileSync(process.execPath, [helper, 'ota'], {
        cwd: f.cwd,
        stdio: 'pipe',
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          RECOVERY_CANDIDATE: candidate,
          RECOVERY_PIPELINE: pipeline,
        },
      });
      return readFileSync(output, 'utf8');
    };
    expect(invoke(first.candidate, first.pipeline)).toContain('ready=true');
    f.write('scripts/mobile-ota-release.ts', '// fixed');
    f.commit();
    expect(invoke(first.candidate, first.pipeline)).toContain('ready=false');
    expect(invoke('', '')).toContain('ready=true');
    const current = f.identity();
    f.write(
      'apps/mobile/ota-promotion.json',
      JSON.stringify({ version: '1.0.2', runtime: '1.0.0' }),
    );
    f.commit();
    expect(invoke(current.candidate, current.pipeline)).toContain('ready=false');
    expect(() => invoke(current.candidate, '')).toThrow();
  });
  it('validates explicit persisted outcomes, including deferral', () => {
    const prefix = `recovery-v1:${'a'.repeat(64)}:${'b'.repeat(64)}:`;
    expect(parseRecoveryReceipt([{ name: prefix + 'deferred' }])?.state).toBe('deferred');
    expect(parseRecoveryReceipt([])).toBeUndefined();
    expect(
      parseRecoveryReceipt([{ name: 'recovery-v1:::failure', conclusion: 'skipped' }]),
    ).toBeUndefined();
    expect(parseRecoveryReceipt([{ name: prefix + 'skipped', conclusion: 'success' }])?.state).toBe(
      'skipped',
    );
    expect(() => parseRecoveryReceipt([{ name: prefix + 'unknown' }])).toThrow();
    expect(() =>
      parseRecoveryReceipt([{ name: prefix + 'success' }, { name: prefix + 'failure' }]),
    ).toThrow();
  });
  it.each(Object.entries(promotionInputs))(
    'wires the %s workflow to the actual preflight and persisted delivery verdict',
    (kind, config) => {
      const workflow = parse(readFileSync(`.github/workflows/${config.workflow}`, 'utf8')) as {
        on: { workflow_dispatch: { inputs: Record<string, { type: string }> } };
        jobs: { promote: { steps: { id?: string; name?: string; run?: string; if?: string }[] } };
      };
      expect(workflow.on.workflow_dispatch.inputs['recovery-candidate']?.type).toBe('string');
      expect(workflow.on.workflow_dispatch.inputs['recovery-pipeline']?.type).toBe('string');
      const steps = workflow.jobs.promote.steps;
      const preflight = steps.findIndex((s: { id?: string }) => s.id === 'recovery');
      const delivery = steps.findIndex((s: { id?: string }) => s.id === 'deliver');
      expect(preflight).toBeGreaterThan(-1);
      expect(delivery).toBeGreaterThan(preflight);
      expect(steps[preflight]?.run).toBe(`node scripts/promotion-recovery.mjs ${kind}`);
      expect(steps[delivery]?.if).toBe("steps.recovery.outputs.ready == 'true'");
      const receipt = steps.find((s: { name?: string }) => s.name?.startsWith('recovery-v1:'));
      expect(receipt?.if).toContain('always()');
      expect(receipt?.name).toContain('steps.deliver.outcome');
      expect(receipt?.name).toContain('steps.deliver.outputs.deferred');
      expect(receipt?.name).toContain(
        "steps.deliver.outcome == 'success' && 'success' || 'failure'",
      );
    },
  );
});
