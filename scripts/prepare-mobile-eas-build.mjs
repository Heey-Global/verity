// npm invokes this inside EAS's unpacked workspace before prebuild/pod install.
// Ordinary installs retain their existing explicit native preparation commands.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';

if (process.env.EAS_BUILD === 'true') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const marker = new URL('../.verity-eas-prepared', import.meta.url);
  if (process.argv.includes('--verify')) {
    // EAS runs this second hook after CocoaPods but before compilation. Fail if
    // npm skipped lifecycle scripts; never repair too late in the build here.
    if (readFileSync(marker, 'utf8') !== root) {
      throw new Error('EAS preparation did not run in this build directory');
    }
  } else {
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
