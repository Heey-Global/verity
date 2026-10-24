import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const installer = readFileSync('features/verity-sandbox-toolkit/install.sh', 'utf8');
const feature = JSON.parse(
  readFileSync('features/verity-sandbox-toolkit/devcontainer-feature.json', 'utf8'),
) as { options: { osvScannerVersion: { default: string } } };
const renovate = JSON.parse(readFileSync('renovate.json', 'utf8')) as {
  customManagers: Array<{ depNameTemplate?: string; matchStrings?: string[] }>;
  packageRules: Array<{ matchPackageNames?: string[]; enabled?: boolean }>;
};

describe('OSV scanner installation', () => {
  it('keeps both Feature version inputs visible to Renovate and in sync', () => {
    const pin = installer.match(
      /# renovate: datasource=github-releases depName=google\/osv-scanner\nOSV_SCANNER_VERSION="\$\{OSVSCANNERVERSION:-([^}]+)\}"/,
    );
    expect(pin?.[1]).toMatch(/^2\.\d+\.\d+$/);
    expect(feature.options.osvScannerVersion.default).toBe(pin?.[1]);
    const manager = renovate.customManagers.find(
      (candidate) => candidate.depNameTemplate === 'google/osv-scanner',
    );
    expect(manager?.matchStrings).toHaveLength(1);
    const match = new RegExp(manager!.matchStrings![0]!).exec(
      readFileSync('features/verity-sandbox-toolkit/devcontainer-feature.json', 'utf8'),
    );
    expect(match?.groups?.currentValue).toBe(pin?.[1]);
    // A version-only Renovate update leaves pinned checksums behind and breaks every rebuild.
    expect(
      renovate.packageRules.find((rule) => rule.matchPackageNames?.includes('google/osv-scanner'))
        ?.enabled,
    ).toBe(false);
  });

  it('verifies each architecture before installing the downloaded executable', () => {
    for (const arch of ['amd64', 'arm64']) {
      const branch = installer.match(new RegExp(`${arch}\\)\\n([\\s\\S]*?);;`))?.[1];
      expect(branch?.match(/OSV_SCANNER_SHA256=([a-f0-9]{64})\b/)?.[1]).toBeDefined();
    }
    expect(installer).toContain('osv-scanner_linux_${ARCH}');
    const verify = installer.indexOf(
      'verify_release_tarball "$OSV_SCANNER_SHA256" "$DOWNLOAD_DIR/osv-scanner"',
    );
    const install = installer.indexOf(
      'install -m 0755 "$DOWNLOAD_DIR/osv-scanner" /usr/local/bin/osv-scanner',
    );
    expect(verify).toBeGreaterThan(0);
    expect(install).toBeGreaterThan(verify);
    expect(installer).toContain('install_trusted_cli_ownership /usr/local/bin/osv-scanner');
    expect(installer).toContain('osv-scanner --version');
  });
});
