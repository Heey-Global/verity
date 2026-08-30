import { describe, expect, it } from 'vitest';

import type { OnboardingStatus } from './api.js';
import {
  ONBOARDING_STEPS,
  ONBOARDING_STEP_IDS,
  normalizeServerUrl,
  resumeStep,
  stepProgress,
  type StepId,
} from './onboarding.js';

/** A fully-incomplete status; override fields per case. */
function status(overrides: Partial<OnboardingStatus> = {}): OnboardingStatus {
  return {
    sealed: true,
    masterPasswordSet: false,
    githubAppConfigured: false,
    signingKeyConfigured: false,
    hasProject: false,
    dopplerConfigured: false,
    claudeConfigured: false,
    codexConfigured: false,
    complete: false,
    nextStep: 'master-password',
    ...overrides,
  };
}

describe('ONBOARDING_STEPS', () => {
  it('lists only the setup wizard steps in order', () => {
    expect(ONBOARDING_STEP_IDS).toEqual([
      'master-password',
      'github',
      'doppler',
      'ai-backends',
      'first-project',
      'done',
    ]);
  });

  it('keeps welcome + server-url out of the numbered setup wizard', () => {
    expect(ONBOARDING_STEP_IDS).not.toContain('welcome' as StepId);
    expect(ONBOARDING_STEP_IDS).not.toContain('server-url' as StepId);
  });

  it('marks credential/project steps required and optional setup steps optional', () => {
    const required = ONBOARDING_STEPS.filter((step) => step.required).map((step) => step.id);
    expect(required).toEqual(['master-password', 'github', 'first-project']);
    const optional = ONBOARDING_STEPS.filter((step) => !step.required).map((step) => step.id);
    expect(optional).toEqual(['doppler', 'ai-backends', 'done']);
  });
});

describe('resumeStep', () => {
  it('returns master-password on a pristine setup after preflight', () => {
    expect(resumeStep(status())).toBe('master-password');
  });

  it('returns done when setup is complete', () => {
    expect(resumeStep(status({ complete: true, nextStep: null }))).toBe('done');
  });

  it('jumps to the first incomplete required step once something is set', () => {
    // Master password done → server says github is next; resume there (not welcome).
    expect(
      resumeStep(
        status({ masterPasswordSet: false, hasProject: true, nextStep: 'master-password' }),
      ),
    ).toBe('master-password');
    expect(
      resumeStep(
        status({ masterPasswordSet: true, githubAppConfigured: false, nextStep: 'github' }),
      ),
    ).toBe('github');
    expect(
      resumeStep(
        status({
          masterPasswordSet: true,
          githubAppConfigured: true,
          signingKeyConfigured: false,
          nextStep: 'github',
        }),
      ),
    ).toBe('github');
    expect(
      resumeStep(
        status({
          masterPasswordSet: true,
          githubAppConfigured: true,
          signingKeyConfigured: true,
          hasProject: false,
          nextStep: 'first-project',
        }),
      ),
    ).toBe('first-project');
  });

  it('falls back to master-password if the server omits nextStep while not complete', () => {
    // Defensive: not complete + some progress but a null nextStep shouldn't crash.
    expect(resumeStep(status({ masterPasswordSet: true, nextStep: null, complete: false }))).toBe(
      'master-password',
    );
  });
});

describe('stepProgress', () => {
  it('reports a 1-based index and the total step count', () => {
    expect(stepProgress('master-password')).toEqual({ index: 1, total: 6 });
    expect(stepProgress('github')).toEqual({ index: 2, total: 6 });
    expect(stepProgress('ai-backends')).toEqual({ index: 4, total: 6 });
    expect(stepProgress('done')).toEqual({ index: 6, total: 6 });
  });

  it('is consistent with the ordered id list for every step', () => {
    for (const [i, id] of ONBOARDING_STEP_IDS.entries()) {
      expect(stepProgress(id)).toEqual({ index: i + 1, total: 6 });
    }
  });

  it('throws on an unknown step id', () => {
    expect(() => stepProgress('nope' as StepId)).toThrow(/unknown onboarding step/);
  });
});

describe('normalizeServerUrl', () => {
  it('prepends http:// when no scheme is present', () => {
    expect(normalizeServerUrl('verity.example.ts.net:8082')).toBe(
      'http://verity.example.ts.net:8082',
    );
    expect(normalizeServerUrl('192.168.1.10:8082')).toBe('http://192.168.1.10:8082');
  });

  it('preserves an explicit scheme (http or https)', () => {
    expect(normalizeServerUrl('https://verity.example.ts.net')).toBe(
      'https://verity.example.ts.net',
    );
    expect(normalizeServerUrl('http://10.0.0.1:8082')).toBe('http://10.0.0.1:8082');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('http://host:8082/')).toBe('http://host:8082');
    expect(normalizeServerUrl('host:8082///')).toBe('http://host:8082');
    expect(normalizeServerUrl('https://host/')).toBe('https://host');
  });

  it('keeps only the server origin when a path is entered', () => {
    expect(normalizeServerUrl('http://host:8082/api')).toBe('http://host:8082');
    expect(normalizeServerUrl('host:8082/api/')).toBe('http://host:8082');
    expect(normalizeServerUrl('https://host/base?x=1#fragment')).toBe('https://host');
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeServerUrl('  host:8082  ')).toBe('http://host:8082');
    expect(normalizeServerUrl('\thttps://host/\n')).toBe('https://host');
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
  });

  it('rejects non-HTTP and malformed addresses', () => {
    expect(normalizeServerUrl('javascript://example')).toBeNull();
    expect(normalizeServerUrl('mailto://user@example.com')).toBeNull();
    expect(normalizeServerUrl('http://')).toBeNull();
  });
});
