// npm invokes this inside EAS's unpacked workspace before prebuild/pod install.
// Ordinary installs retain their existing explicit native preparation commands.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

// The local EAS builder uses '1'; verification must never silently skip itself.
const verify = process.argv.includes('--verify');
if (verify || ['true', '1'].includes(process.env.EAS_BUILD ?? '')) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const marker = new URL('../.verity-eas-prepared', import.meta.url);
  if (verify) {
    // EAS runs this second hook after CocoaPods but before compilation. Fail if
    // npm skipped lifecycle scripts; never repair too late in the build here.
    if (readFileSync(marker, 'utf8') !== root) {
      throw new Error('EAS preparation did not run in this build directory');
    }
  } else {
    if (['testflight', 'staging', 'production'].includes(process.env.EAS_BUILD_PROFILE ?? '')) {
      // Change only EAS's unpacked manifest before prebuild discovers native pods.
      const manifest = new URL('../apps/mobile/package.json', import.meta.url);
      /** @type {unknown} */
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      const app = /** @type {{ expo?: { autolinking?: { ios?: { exclude?: string[] } } } }} */ (
        parsed
      );
      const ios = (((app.expo ??= {}).autolinking ??= {}).ios ??= {});
      ios.exclude = [
        ...new Set([
          ...(ios.exclude ?? []),
          'expo-dev-client',
          'expo-dev-menu',
          'expo-dev-launcher',
        ]),
      ];
      writeFileSync(manifest, `${JSON.stringify(app, null, 2)}\n`);
    }
    execFileSync(process.execPath, ['scripts/patch-mobile-native-deps.mjs'], {
      cwd: root,
      stdio: 'inherit',
    });
    execFileSync('npm', ['run', '--workspace', '@verity/mobile', 'build'], {
      cwd: root,
      stdio: 'inherit',
    });
    writeFileSync(marker, root);
  }
}
