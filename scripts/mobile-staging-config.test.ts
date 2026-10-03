import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
async function config(variant: string) {
  vi.stubEnv('VERITY_APP_VARIANT', variant);
  vi.stubEnv('EXPO_UPDATE_CHANNEL', '');
  return (await import('../apps/mobile/app.config.js')).default;
}
describe('separate Staging application', () => {
  it('isolates native identity, deep links, OTA channel and runtime', async () => {
    const production = await config('production');
    vi.resetModules();
    const staging = await config('staging');
    expect(staging.ios?.bundleIdentifier).not.toBe(production.ios?.bundleIdentifier);
    expect(staging.android?.package).not.toBe(production.android?.package);
    expect(staging.scheme?.[0]).not.toBe(production.scheme?.[0]);
    expect(staging.runtimeVersion).toBe(`staging-${String(production.runtimeVersion)}`);
    expect(staging.updates?.requestHeaders?.['expo-channel-name']).toBe('staging');
  });
  it('refuses a production OTA channel embedded in the staging app', async () => {
    vi.stubEnv('VERITY_APP_VARIANT', 'staging');
    vi.stubEnv('EXPO_UPDATE_CHANNEL', 'production');
    await expect(import('../apps/mobile/app.config.js')).rejects.toThrow('Staging app requires');
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
