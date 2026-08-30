import { describe, expect, it } from 'vitest';
import {
  dockerEnvPassthrough,
  isSensitiveEnvKey,
  projectSettingsEnv,
} from './project-settings-env.js';

describe('project settings environment', () => {
  it('never projects legacy Doppler credentials into the container', () => {
    const env = projectSettingsEnv({
      defaultBranch: 'main',
      defaultModel: null,
    });
    expect(env?.DOPPLER_TOKEN).toBeUndefined();
    expect(env).toEqual({ VERITY_PROJECT_DEFAULT_BRANCH: 'main' });
  });
});

describe('dockerEnvPassthrough (M8)', () => {
  it('classifies real secrets as sensitive, references/paths as not', () => {
    expect(isSensitiveEnvKey('DOPPLER_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isSensitiveEnvKey('VERITY_DOPPLER_TOKEN_REF')).toBe(false);
    expect(isSensitiveEnvKey('VERITY_GH_TOKEN_FILE')).toBe(false);
    expect(isSensitiveEnvKey('PATH')).toBe(false);
    expect(isSensitiveEnvKey('VERITY_PROJECT_DEV_SERVER_URL')).toBe(true);
    expect(isSensitiveEnvKey('DATABASE_URL')).toBe(true);
  });

  it('passes secrets by reference (value in env, not argv) and inlines the rest', () => {
    const { args, env } = dockerEnvPassthrough({
      PATH: '/opt/agent-seed/bin',
      VERITY_DOPPLER_TOKEN_REF: 'doppler://verity/prod',
      DATABASE_URL: 'postgres://user:password@db/verity',
      DOPPLER_TOKEN: 'super-secret',
    });
    // Non-secrets inline.
    expect(args).toContain('PATH=/opt/agent-seed/bin');
    expect(args).toContain('VERITY_DOPPLER_TOKEN_REF=doppler://verity/prod');
    // Secret by reference only — the value is nowhere on the command line.
    expect(args).toContain('DOPPLER_TOKEN');
    expect(args.join(' ')).not.toContain('super-secret');
    expect(args.join(' ')).not.toContain('postgres://');
    // Its value rides the process env instead.
    expect(env).toEqual({
      DATABASE_URL: 'postgres://user:password@db/verity',
      DOPPLER_TOKEN: 'super-secret',
    });
  });

  it('returns empty args/env for undefined input', () => {
    expect(dockerEnvPassthrough(undefined)).toEqual({ args: [], env: {} });
  });
});
