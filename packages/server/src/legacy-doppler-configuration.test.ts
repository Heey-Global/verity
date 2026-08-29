import { describe, expect, it } from 'vitest';

import { legacyDopplerCredentialEnvironmentKeys } from './legacy-doppler-configuration.js';

describe('legacy Doppler credential configuration', () => {
  it('detects every removed credential environment form without matching mappings', () => {
    expect(
      legacyDopplerCredentialEnvironmentKeys({
        DOPPLER_TOKEN: 'legacy',
        VERITY_DOPPLER_TOKEN_REF: 'legacy-ref',
        DOPPLER_TOKEN_CLUSTER_PROD: 'legacy-scoped',
        DOPPLER_PROJECT: 'mapping-only',
        DOPPLER_CONFIG: 'mapping-only',
      }),
    ).toEqual(['DOPPLER_TOKEN', 'DOPPLER_TOKEN_CLUSTER_PROD', 'VERITY_DOPPLER_TOKEN_REF']);
  });

  it('accepts an environment with no legacy credential path', () => {
    expect(
      legacyDopplerCredentialEnvironmentKeys({
        DATABASE_URL: 'postgres://database',
        VERITY_SECRET_JOB_RUNTIME_REQUIRED: 'true',
      }),
    ).toEqual([]);
  });
});
