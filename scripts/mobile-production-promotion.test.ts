import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  candidate: {
    schema: 1,
    product: 'mobile-native',
    version: '2.0.0',
    source: 'a'.repeat(40),
    appId: '123',
    buildId: 'build-id',
    buildNumber: '12',
    releasePr: 42,
  },
  calls: [] as string[],
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn(() => JSON.stringify(fixture.candidate)),
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((command: string, args: string[]) => {
    fixture.calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git') return 'a'.repeat(40);
    if (args[0] === 'release')
      return args[1] === 'download' ? JSON.stringify(fixture.candidate) : '';
    const endpoint = args.find((v) => v.startsWith('repos/')) ?? '';
    if (endpoint.endsWith('/pulls'))
      return JSON.stringify([
        {
          number: 7,
          merged_at: '2026-01-01',
          head: { ref: 'automation/promote-mobile-production', sha: 'b'.repeat(40) },
          base: { ref: 'main' },
        },
      ]);
    if (endpoint.includes('/reviews?')) return JSON.stringify([[]]);
    if (endpoint.includes('/contents/'))
      return JSON.stringify({
        content: Buffer.from(JSON.stringify(fixture.candidate)).toString('base64'),
      });
    if (endpoint.includes('/check-runs?'))
      return JSON.stringify([
        {
          check_runs: [
            { id: 1, name: 'ci-checks', conclusion: 'success', app: { slug: 'github-actions' } },
          ],
        },
      ]);
    throw new Error(`Unhandled mock ${endpoint}`);
  }),
}));
import { promoteNative } from './production-promotion.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixture.calls = [];
});
function setup(change: Record<string, string> = {}) {
  vi.stubEnv('GITHUB_REPOSITORY', 'example/repo');
  vi.stubEnv('ASC_APP_ID', '123');
  vi.stubEnv('ASC_KEY_ID', 'test');
  vi.stubEnv('ASC_ISSUER_ID', 'test');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  vi.stubEnv('ASC_KEY_P8', privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const requests: { path: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.appstoreconnect.apple.com/v1/', '');
      const method = init.method ?? 'GET';
      requests.push({ path, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      let data: unknown;
      if (path === 'apps/123')
        data = { attributes: { bundleId: change.bundle ?? 'build.verity.app' } };
      else if (path === 'builds/build-id')
        data = { attributes: { version: '12', processingState: change.processing ?? 'VALID' } };
      else if (path.endsWith('/preReleaseVersion'))
        data = { attributes: { version: change.version ?? '2.0.0', platform: 'IOS' } };
      else if (path === 'builds/build-id/app') data = { id: change.app ?? '123' };
      else if (path.includes('/appStoreVersions?'))
        data = [{ id: 'version-id', attributes: { appStoreState: 'PREPARE_FOR_SUBMISSION' } }];
      else if (path === 'appStoreVersions/version-id/build')
        data = { id: change.selected ?? 'build-id' };
      else if (path.includes('/reviewSubmissions?')) data = [];
      else if (path === 'reviewSubmissions' && method === 'POST') data = { id: 'submission-id' };
      else if (path === 'reviewSubmissions/submission-id/items') data = [];
      else if (path === 'reviewSubmissionItems' || path === 'reviewSubmissions/submission-id')
        data = { id: 'submission-id' };
      else throw new Error(`Unhandled Apple ${path}`);
      return Response.json({ data });
    }),
  );
  return requests;
}
describe('native production submission', () => {
  it.each([
    { bundle: 'build.verity.app.staging' },
    { app: '456' },
    { version: '3.0.0' },
    { selected: 'another-build' },
    { processing: 'INVALID' },
  ])('refuses conflicting Apple identities before submission (%j)', async (change) => {
    const requests = setup(change);
    await expect(promoteNative()).rejects.toThrow();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(fixture.calls.some((call) => call.includes('release edit'))).toBe(false);
  });
  it('submits the exact approved build and records production only after Apple accepts', async () => {
    const requests = setup();
    await promoteNative();
    expect(requests.at(-1)).toMatchObject({
      path: 'reviewSubmissions/submission-id',
      method: 'PATCH',
      body: { data: { attributes: { submitted: true } } },
    });
    expect(fixture.calls.at(-1)).toContain('release edit mobile-v2.0.0 --prerelease=false');
  });
});
