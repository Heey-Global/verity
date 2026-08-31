import { describe, expect, it } from 'vitest';

import { DEVCONTAINER_IMAGE_PREFIX, usesDevcontainerImage } from './devcontainerImage.js';

describe('usesDevcontainerImage', () => {
  it('recognizes an image Verity built from the repo devcontainer', () => {
    expect(usesDevcontainerImage('verity-devc-heey-global-verity:0123456789ab')).toBe(true);
    expect(usesDevcontainerImage(`${DEVCONTAINER_IMAGE_PREFIX}acme-app:cafebabe1234`)).toBe(true);
  });

  it('rejects the pulled sandbox image and a configured override', () => {
    expect(usesDevcontainerImage('ghcr.io/heey-global/verity-sandbox@sha256:abc')).toBe(false);
    expect(usesDevcontainerImage('node:24')).toBe(false);
  });

  it('reads a project with no recorded image as not-built rather than throwing', () => {
    // A project that has never finished a provisioning attempt has `imageRef`
    // null. The Rebuild action it gates would be rejected by the server in that
    // state anyway, so false is both the safe and the correct answer.
    expect(usesDevcontainerImage(null)).toBe(false);
    expect(usesDevcontainerImage(undefined)).toBe(false);
    expect(usesDevcontainerImage('')).toBe(false);
  });

  it('does not match a registry image that merely contains the prefix', () => {
    // The prefix is only meaningful at the start: Verity's derived tags are
    // local and unqualified, so anything with a registry host in front of it is
    // someone else's image.
    expect(usesDevcontainerImage('ghcr.io/acme/verity-devc-fake:1')).toBe(false);
  });
});
