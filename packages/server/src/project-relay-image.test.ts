import { describe, expect, it } from 'vitest';

import { resolveProjectRelayImage } from './project-relay-image.js';

describe('resolveProjectRelayImage', () => {
  it('uses the relay bundled with the official Server release', () => {
    expect(
      resolveProjectRelayImage({
        VERITY_BUNDLED_PROJECT_RELAY_IMAGE: ' relay@sha256:release ',
      }),
    ).toBe('relay@sha256:release');
  });

  it('allows an explicit custom-topology override', () => {
    expect(
      resolveProjectRelayImage({
        VERITY_BUNDLED_PROJECT_RELAY_IMAGE: 'relay@sha256:release',
        VERITY_PROJECT_RELAY_IMAGE: ' relay@sha256:override ',
      }),
    ).toBe('relay@sha256:override');
  });

  it('fails closed when neither source exists', () => {
    expect(() => resolveProjectRelayImage({})).toThrow(
      'a bundled or VERITY_PROJECT_RELAY_IMAGE relay image is required',
    );
  });
});
