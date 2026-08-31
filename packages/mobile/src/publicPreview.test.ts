import { describe, expect, it } from 'vitest';
import { canCreatePublicPreviewTarget } from './publicPreview.js';

describe('canCreatePublicPreviewTarget', () => {
  it('allows a static share for an active project without a running dev server', () => {
    expect(
      canCreatePublicPreviewTarget('static-folder', {
        projectActive: true,
        devServerRunning: false,
      }),
    ).toBe(true);
  });

  it('still requires a running dev server for a dev-server share', () => {
    expect(
      canCreatePublicPreviewTarget('dev-server', {
        projectActive: true,
        devServerRunning: false,
      }),
    ).toBe(false);
  });
});
