import { describe, expect, it } from 'vitest';

import { forbiddenDopplerCredentialEnvironmentKeys } from './doppler-credential-environment.js';

describe('Doppler credential environment boundary', () => {
  it('detects project credentials without matching non-secret mappings', () => {
    expect(
      forbiddenDopplerCredentialEnvironmentKeys({
        DOPPLER_TOKEN: 'forbidden',
        VERITY_DOPPLER_TOKEN_REF: 'forbidden-ref',
        DOPPLER_TOKEN_CLUSTER_PROD: 'forbidden-scoped',
        DOPPLER_PROJECT: 'mapping-only',
        DOPPLER_CONFIG: 'mapping-only',
      }),
    ).toEqual(['DOPPLER_TOKEN', 'DOPPLER_TOKEN_CLUSTER_PROD', 'VERITY_DOPPLER_TOKEN_REF']);
  });

  it('accepts an environment with only the central broker path', () => {
    expect(
      forbiddenDopplerCredentialEnvironmentKeys({
        DATABASE_URL: 'postgres://database',
        VERITY_SECRET_JOB_RUNTIME_REQUIRED: 'true',
      }),
    ).toEqual([]);
  });
});
