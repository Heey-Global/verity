import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../app.config';

// Expo's own discovery: a file counts as an inline module when it declares a
// `definition() -> ModuleDefinition`, and its module class is taken from the
// file name.
const { hasSwiftModuleDefinition, getSwiftModuleClassName } =
  require('expo-modules-autolinking/build/inlineModules/inlineModules') as {
    hasSwiftModuleDefinition(path: string): Promise<boolean>;
    getSwiftModuleClassName(path: string): string;
  };

describe('iOS inline modules', () => {
  // The silent failure: a module class that does not match its file name makes
  // the generated module list name a class that is not a Module, which only
  // surfaces as a Swift compile error on the macOS runner.
  it('declares each module class under the name Expo derives from its file', async () => {
    const watched = (config.experiments as { inlineModules?: { watchedDirectories?: string[] } })
      ?.inlineModules?.watchedDirectories;
    expect(watched?.length).toBeGreaterThan(0);
    let modules = 0;
    for (const directory of watched ?? []) {
      const root = resolve(__dirname, '..', directory);
      for (const file of readdirSync(root).filter((name) => name.endsWith('.swift'))) {
        const path = resolve(root, file);
        if (!(await hasSwiftModuleDefinition(path))) continue;
        modules += 1;
        const name = getSwiftModuleClassName(path);
        expect({ file, declares: readFileSync(path, 'utf8') }).toEqual({
          file,
          declares: expect.stringMatching(new RegExp(`\\bclass ${name}\\s*:\\s*Module\\b`)),
        });
      }
    }
    expect(modules).toBeGreaterThan(0);
  });
});
