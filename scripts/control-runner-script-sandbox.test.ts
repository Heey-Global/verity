import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Control runner script sandbox image provisioning', () => {
  it.each(['amd64', 'arm64'])(
    'installs the verified %s helper and refuses corrupt artifacts',
    (architecture) => {
      const dockerfile = readFileSync('deploy/Dockerfile', 'utf8');
      // Bundling the Feature alone leaves the Control supervisor running without script isolation.
      const block = dockerfile.match(
        /RUN set -eu; \\\n[\s\S]*?install -m 0755 "linux-\$TARGETARCH\/verity-script-sandbox" \/usr\/local\/bin\/verity-script-sandbox/,
      );
      expect(block).not.toBeNull();
      const root = mkdtempSync(join(tmpdir(), 'control-script-sandbox-'));
      try {
        const prebuilt = join(root, 'prebuilt');
        const installed = join(root, 'verity-script-sandbox');
        cpSync('features/verity-sandbox-toolkit/prebuilt', prebuilt, { recursive: true });
        const command = block![0]
          .slice(4)
          .replaceAll('\\\n', '\n')
          .replace('/opt/verity-features/verity-sandbox-toolkit/prebuilt', prebuilt)
          .replace('/usr/local/bin/verity-script-sandbox', installed);
        const run = () =>
          execFileSync('sh', ['-c', command], {
            env: { ...process.env, TARGETARCH: architecture },
            stdio: 'pipe',
          });
        run();
        expect(readFileSync(installed)).toEqual(
          readFileSync(join(prebuilt, `linux-${architecture}/verity-script-sandbox`)),
        );
        expect(statSync(installed).mode & 0o777).toBe(0o755);
        rmSync(installed);
        writeFileSync(join(prebuilt, `linux-${architecture}/verity-script-sandbox`), 'corrupt');
        expect(run).toThrow();
        copyFileSync(
          resolve(
            `features/verity-sandbox-toolkit/prebuilt/linux-${architecture}/verity-script-sandbox`,
          ),
          join(prebuilt, `linux-${architecture}/verity-script-sandbox`),
        );
        writeFileSync(join(prebuilt, 'sha256sums.txt'), '');
        expect(run).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
