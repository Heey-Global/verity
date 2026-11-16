import { afterEach, expect, it, vi } from 'vitest';

const construct = vi.hoisted(() => vi.fn());
vi.mock('./index.js', () => ({
  PreviewEdge: construct,
  validWebhookPath: () => true,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  construct.mockClear();
  vi.resetModules();
});

it.each([
  ['VERITY_PREVIEW_PIN_BUDGET_URL', '', /VERITY_PREVIEW_PIN_BUDGET_URL is required/],
  ['VERITY_PREVIEW_PIN_BUDGET_TOKEN', '', /VERITY_PREVIEW_PIN_BUDGET_TOKEN is required/],
  ['VERITY_PREVIEW_PIN_BUDGET_URL', 'ftp://uplink', /Invalid preview PIN budget URL/],
  ['VERITY_PREVIEW_PIN_BUDGET_TOKEN', 'wrong', /Invalid preview PIN budget token/],
] as const)('refuses hosted startup with invalid %s=%s', async (name, value, error) => {
  for (const key of [
    'VERITY_PREVIEW_MAX_BODY_BYTES',
    'VERITY_PREVIEW_REQUEST_TIMEOUT_MS',
    'VERITY_PREVIEW_TRUSTED_PROXY_HOPS',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('VERITY_PREVIEW_SHARE_ID', 'share');
  vi.stubEnv('VERITY_PREVIEW_PIN_BUDGET_URL', 'http://uplink');
  vi.stubEnv('VERITY_PREVIEW_PIN_BUDGET_TOKEN', 'a'.repeat(43));
  vi.stubEnv(name, value);
  await expect(import('./edge-main.js')).rejects.toThrow(error);
  expect(construct).not.toHaveBeenCalled();
});
