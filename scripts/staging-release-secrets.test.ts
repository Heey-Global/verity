import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('staging release configuration', () => {
  // A secret configured alongside production credentials must reach every
  // staging consumer; reading the empty vars namespace silently drops it.
  for (const path of [
    '.github/workflows/release.yml',
    '.github/workflows/mobile-native-build.yml',
    '.github/workflows/mobile-ota.yml',
  ]) {
    it(`uses repository secrets in ${path}`, () => {
      const workflow = readFileSync(path, 'utf8');
      expect(workflow).toContain('secrets.STAGING_GOOGLE_AUTH_ID');
      expect(workflow).not.toMatch(/vars\.STAGING_(ASC_APP_ID|GOOGLE_AUTH_ID)/);
      if (path.endsWith('/mobile-native-build.yml'))
        expect(workflow).toContain('secrets.STAGING_ASC_APP_ID');
      if (path.endsWith('/mobile-native-build.yml')) {
        expect(workflow).toContain('[ -z "${STAGING_ASC_APP_ID:-}" ]');
        expect(workflow).toContain('[ -z "${STAGING_GOOGLE_AUTH_ID:-}" ]');
        expect(workflow).not.toMatch(/\[ -z "\$\{\{ secrets\.STAGING_/);
      }
    });
  }
});
