import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

function config(variant: string, channel = '') {
  // Contract CI omits Expo; Node's type stripping evaluates the real config
  // without loading the mobile tsconfig or its development dependencies.
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import config from ${JSON.stringify(pathToFileURL(resolve('apps/mobile/app.config.ts')).href)}; process.stdout.write(JSON.stringify(config));`,
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VERITY_APP_VARIANT: variant, EXPO_UPDATE_CHANNEL: channel },
      },
    ),
  ) as {
    ios: { bundleIdentifier: string };
    android: { package: string };
    scheme: string[];
    runtimeVersion: string;
    updates: { requestHeaders: Record<string, string> };
  };
}
describe('separate Staging application', () => {
  it('isolates native identity, deep links, OTA channel and runtime', () => {
    const production = config('production');
    const staging = config('staging');
    expect(staging.ios?.bundleIdentifier).not.toBe(production.ios?.bundleIdentifier);
    expect(staging.android?.package).not.toBe(production.android?.package);
    expect(staging.scheme?.[0]).not.toBe(production.scheme?.[0]);
    expect(staging.runtimeVersion).toBe(`staging-${String(production.runtimeVersion)}`);
    expect(staging.updates?.requestHeaders?.['expo-channel-name']).toBe('staging');
  });
  it('refuses a production OTA channel embedded in the staging app', () => {
    expect(() => config('staging', 'production')).toThrow('Staging app requires');
  });
  it('routes the production TestFlight binary to the App Store OTA channel', () => {
    const profiles = JSON.parse(readFileSync('apps/mobile/eas.json', 'utf8')) as {
      build: Record<string, { channel: string; env?: Record<string, string> }>;
    };
    expect(profiles.build.testflight!.channel).toBe(profiles.build.production!.channel);
    expect(profiles.build.staging!.channel).not.toBe(profiles.build.production!.channel);
    expect(profiles.build.staging!.env?.VERITY_APP_VARIANT).toBe('staging');
  });
});
