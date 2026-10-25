import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Apple target CocoaPods integration', () => {
  // The loader derives the Podfile target from the directory, ignoring the
  // configured name; a mismatch prevents pod install before native compilation.
  it('matches each pods.rb directory to its configured Xcode target', () => {
    const root = resolve(__dirname, '../targets');
    let targets = 0;
    for (const directory of readdirSync(root)) {
      const targetRoot = resolve(root, directory);
      if (!existsSync(resolve(targetRoot, 'pods.rb'))) continue;
      targets += 1;
      const config = require(resolve(targetRoot, 'expo-target.config.js')) as { name?: string };
      expect(config.name ?? directory).toBe(directory);
    }
    expect(targets).toBeGreaterThan(0);
  });
});
