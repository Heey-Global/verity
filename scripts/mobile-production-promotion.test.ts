import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  candidate: {
    schema: 1,
    artifact: undefined as { id: number; sha256: string } | undefined,
    product: 'mobile-native',
    version: '2.0.0',
    source: 'a'.repeat(40),
    appId: '123',
    buildId: 'build-id',
    buildNumber: '12',
    releasePr: 42,
  },
  recorded: undefined as Record<string, unknown> | undefined,
  approved: true,
  expired: false,
  root: '',
  calls: [] as string[],
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  readFileSync: vi.fn((path: string) =>
    path.endsWith('Verity.ipa')
      ? Buffer.from('approved archive')
      : JSON.stringify(fixture.candidate),
  ),
}));
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((command: string, args: string[]) => {
    fixture.calls.push(`${command} ${args.join(' ')}`);
    if (command === 'ditto' || command === 'xcrun') return '';
    if (command === 'git') return 'a'.repeat(40);
    if (args[0] === 'release')
      return args[1] === 'download'
        ? JSON.stringify(fixture.recorded ?? fixture.candidate)
        : args[1] === 'view'
          ? 'false'
          : '';
    const endpoint = args.find((v) => v.startsWith('repos/')) ?? '';
    if (endpoint.includes('/actions/artifacts/'))
      return JSON.stringify({
        expired: fixture.expired,
        archive_download_url: 'https://artifacts.example/archive',
      });
    if (endpoint.endsWith('/pulls') && !fixture.approved) return '[]';
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixture.calls = [];
  fixture.candidate.schema = 1;
  fixture.candidate.artifact = undefined;
  fixture.recorded = undefined;
  fixture.approved = true;
  fixture.expired = false;
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
  fixture.root = '';
});
function setup(change: Record<string, string> = {}) {
  fixture.root = mkdtempSync(`${tmpdir()}/verity-approved-`);
  vi.stubEnv('RUNNER_TEMP', fixture.root);
  vi.stubEnv('HOME', fixture.root);
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
      if (url === 'https://artifacts.example/archive') return new Response('mock zip');
      const path = url.replace('https://api.appstoreconnect.apple.com/v1/', '');
      const method = init.method ?? 'GET';
      requests.push({
        path,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      let data: unknown;
      if (path.startsWith('builds?')) {
        const uploaded = fixture.calls.some((call) => call.startsWith('xcrun '));
        data =
          uploaded || change.existing
            ? [{ id: 'build-id', attributes: { processingState: change.processing ?? 'VALID' } }]
            : [];
      } else if (path === 'apps/123')
        data = { attributes: { bundleId: change.bundle ?? 'build.verity.app' } };
      else if (path === 'builds/build-id')
        data = { attributes: { version: '12', processingState: change.processing ?? 'VALID' } };
      else if (path.endsWith('/preReleaseVersion'))
        data = { attributes: { version: change.version ?? '2.0.0', platform: 'IOS' } };
      else if (path === 'builds/build-id/app') data = { id: change.app ?? '123' };
      else if (path === 'builds/build-id/buildBetaDetail')
        data = {
          attributes: {
            internalBuildState:
              change.warming &&
              requests.filter((request) => request.path.endsWith('/buildBetaDetail')).length === 1
                ? 'READY_FOR_BETA_TESTING'
                : (change.state ?? 'IN_BETA_TESTING'),
          },
        };
      else throw new Error(`Unhandled Apple ${path}`);
      return Response.json({ data });
    }),
  );
  return requests;
}
describe('native TestFlight promotion', () => {
  it.each([
    { bundle: 'build.verity.app.staging' },
    { app: '456' },
    { version: '3.0.0' },
    { processing: 'INVALID' },
    { state: 'READY_FOR_BETA_TESTING' },
    { state: 'EXPIRED' },
  ])('refuses unavailable or conflicting builds (%j)', async (change) => {
    const requests = setup(change);
    await expect(promoteNative()).rejects.toThrow();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(fixture.calls.some((call) => call.includes('release edit'))).toBe(false);
  });
  it('promotes the approved TestFlight build without submitting to the App Store', async () => {
    const requests = setup();
    await promoteNative();
    expect(requests.at(-1)?.path).toBe('builds/build-id/buildBetaDetail');
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(fixture.calls.at(-1)).toContain('release edit mobile-v2.0.0 --prerelease=false');
  });
});

function preparedCandidate() {
  fixture.candidate.schema = 2;
  fixture.candidate.artifact = {
    id: 99,
    sha256: createHash('sha256').update('approved archive').digest('hex'),
  };
}
describe('unuploaded native archives', () => {
  it('uploads the exact archived IPA after merged approval and then finalizes TestFlight', async () => {
    setup();
    preparedCandidate();
    await promoteNative();
    const upload = fixture.calls.findIndex((call) => call.startsWith('xcrun '));
    expect(upload).toBeGreaterThan(fixture.calls.findIndex((call) => call.includes('/pulls')));
    expect(fixture.calls[upload]).toContain('--file');
    expect(fixture.calls.at(-1)).toContain('release edit');
  });
  it.each(['unapproved', 'expired', 'different-bytes'])(
    'never uploads an invalid archive (%s)',
    async (scenario) => {
      setup();
      preparedCandidate();
      if (scenario === 'unapproved') fixture.approved = false;
      if (scenario === 'expired') fixture.expired = true;
      if (scenario === 'different-bytes') fixture.candidate.artifact!.sha256 = '0'.repeat(64);
      await expect(promoteNative()).rejects.toThrow();
      expect(fixture.calls.some((call) => call.startsWith('xcrun '))).toBe(false);
      expect(fixture.calls.some((call) => call.includes('release edit'))).toBe(false);
    },
  );
  it('waits for internal TestFlight delivery after Apple accepts the binary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const requests = setup({ warming: 'true' });
    preparedCandidate();
    const promotion = promoteNative();
    await vi.waitFor(() =>
      expect(requests.some((request) => request.path.endsWith('/buildBetaDetail'))).toBe(true),
    );
    expect(fixture.calls.some((call) => call.includes('release edit'))).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await promotion;
    expect(fixture.calls.at(-1)).toContain('release edit');
  });
  it('does not publish a production release when Apple rejects the upload', async () => {
    setup({ processing: 'INVALID' });
    preparedCandidate();
    await expect(promoteNative()).rejects.toThrow('Apple rejected');
    expect(fixture.calls.some((call) => call.includes('release edit'))).toBe(false);
  });
  it('refuses an old merged approval after its archive has been replaced', async () => {
    setup();
    preparedCandidate();
    fixture.recorded = { ...fixture.candidate, artifact: { id: 100, sha256: 'b'.repeat(64) } };
    await expect(promoteNative()).rejects.toThrow('differs from recorded release evidence');
    expect(fixture.calls.some((call) => call.startsWith('xcrun '))).toBe(false);
  });
  it('resumes an accepted upload without submitting the binary twice', async () => {
    setup({ existing: 'true' });
    preparedCandidate();
    await promoteNative();
    expect(fixture.calls.some((call) => call.startsWith('xcrun '))).toBe(false);
    expect(fixture.calls.at(-1)).toContain('release edit');
  });
});
