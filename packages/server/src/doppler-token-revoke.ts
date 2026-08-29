import type { LegacyDopplerTokenRevokeInput } from './doppler-legacy-cutover.js';

export async function revokeLegacyDopplerToken(
  input: LegacyDopplerTokenRevokeInput,
  options: { fetch?: typeof fetch; timeoutMs?: number; apiBaseUrl?: string } = {},
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.apiBaseUrl ?? 'https://api.doppler.com').replace(/\/+$/u, '')}/v3/configs/config/tokens`;
  const authorization = Buffer.concat([Buffer.from('Bearer ', 'ascii'), input.credential]);
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Web Fetch coerces header values at its boundary. Keep our complete
        // header in an owned buffer and erase it immediately after dispatch.
        Authorization: authorization as unknown as string,
        'User-Agent': 'verity',
      },
      body: JSON.stringify({ project: input.project, config: input.config, slug: input.slug }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch {
    throw new Error('legacy Doppler token revocation transport failed');
  } finally {
    authorization.fill(0);
  }
  if (response.ok || response.status === 404) return;
  throw new Error(`legacy Doppler token revocation failed (HTTP ${String(response.status)})`);
}
