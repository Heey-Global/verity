import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import mobileConfig from '../apps/mobile/app.config.js';

const require = createRequire(import.meta.url);
type SceneManifest = {
  UIApplicationSceneManifest: {
    UIApplicationSupportsMultipleScenes: boolean;
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: { UISceneDelegateClassName: string }[];
    };
  };
};
type Mod<T> = (config: {
  modResults: T;
  modRequest: { nextMod: (value: unknown) => Promise<unknown> };
}) => Promise<{ modResults: T }>;
type PluginResult = {
  mods: {
    ios: {
      appDelegate: Mod<{ language: string; contents: string }>;
      infoPlist: Mod<Partial<SceneManifest>>;
    };
  };
};
const plugin = require('../apps/mobile/plugins/withSceneLifecycle.js') as {
  (config: unknown): PluginResult;
  migrateAppDelegate(contents: string): string;
};
// SDK 57 bare-minimum AppDelegate, captured from expo/expo's sdk-57 template.
const template = readFileSync('scripts/fixtures/mobile/Expo57AppDelegate.swift', 'utf8');

async function generate() {
  const config = plugin({ ...mobileConfig });
  const base = { ...config, modRequest: { nextMod: async (value: unknown) => value } };
  const app = await config.mods.ios.appDelegate({
    ...base,
    modResults: { language: 'swift', contents: template },
  });
  const plist = await config.mods.ios.infoPlist({ ...base, modResults: {} });
  return { swift: app.modResults.contents, plist: plist.modResults };
}

describe('iOS scene lifecycle', () => {
  it('registers the migration in the actual app config', () => {
    // A plugin that works in isolation still ships the launch trap if omitted from CNG.
    expect(mobileConfig.plugins).toContain('./plugins/withSceneLifecycle');
  });

  it('connects the declared scene to a scene-owned window and starts React only there', async () => {
    const { swift, plist } = await generate();
    const manifest = plist.UIApplicationSceneManifest!;
    expect(manifest.UIApplicationSupportsMultipleScenes).toBe(false);
    const declared =
      manifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName.split(
        '.',
      ).at(-1);
    expect(swift).toContain(`class ${declared}: UIResponder, UIWindowSceneDelegate`);
    const [app, scene] = swift.split(`class ${declared}:`);
    expect(app).not.toContain('startReactNative(');
    expect(swift).not.toContain('UIWindow(frame:');
    expect(scene).toContain('UIWindow(windowScene: windowScene)');
    expect(scene).toContain('appDelegate.window = window');
    expect(scene.match(/startReactNative\(/g)).toHaveLength(1);
    expect(app).toContain(
      'super.application(application, didFinishLaunchingWithOptions: launchOptions)',
    );
  });

  it('preserves cold links, warm links and Expo lifecycle callbacks', async () => {
    const { swift } = await generate();
    expect(swift).toContain('sceneLaunchOptions = launchOptions');
    expect(swift).toContain('launchOptions[.url] = context.url');
    expect(swift).toContain('launchOptions[.userActivityDictionary]');
    expect(swift).toContain('launchOptions[.remoteNotification]');
    expect(swift).toContain('open: context.url, options: options');
    expect(swift).toContain('continue: userActivity, restorationHandler:');
    for (const callback of [
      'DidBecomeActive',
      'WillResignActive',
      'WillEnterForeground',
      'DidEnterBackground',
    ]) {
      expect(swift).toContain(`?.application${callback}(UIApplication.shared)`);
    }
  });

  it('is idempotent and rejects template drift rather than retaining legacy startup', () => {
    const migrated = plugin.migrateAppDelegate(template);
    expect(plugin.migrateAppDelegate(migrated)).toBe(migrated);
    expect(() =>
      plugin.migrateAppDelegate(template.replace('factory.startReactNative(', 'factory.boot(')),
    ).toThrow('startup changed');
  });
});
