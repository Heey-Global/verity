import { randomBytes, X509Certificate } from 'node:crypto';
import { request } from 'node:https';

/** A configured endpoint is authoritative; redirects never receive credentials. */
export function normalizeForgejoUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Forgejo URL must use HTTPS without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/u, '');
}

export function validateForgejoCa(pem: string | null | undefined): void {
  if (!pem) return;
  const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
  if (!certificates?.length || pem.includes('PRIVATE KEY') || pem.length > 256_000) {
    throw new Error('Invalid CA certificate bundle');
  }
  for (const certificate of certificates) new X509Certificate(certificate);
}

export class ForgejoRequestError extends Error {
  constructor(readonly status: number) {
    super(`Forgejo request failed (${status})`);
  }
}

export class ForgejoTransport {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly token: () => Promise<string | undefined>,
    private readonly customCaPem?: string | null,
  ) {
    this.baseUrl = normalizeForgejoUrl(baseUrl);
    validateForgejoCa(customCaPem);
  }

  async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    // Reject path normalization before constructing a URL; callers cannot escape
    // a configured reverse-proxy prefix or turn an API path into another origin.
    if (
      path.includes('//') ||
      !/^\/[a-zA-Z0-9_/?=&%.,:@+-]*$/u.test(path) ||
      /(?:^|\/)\.\.(?:\/|$)|%2f|%5c|%2e/iu.test(path)
    ) {
      throw new Error('Invalid Forgejo API path');
    }
    const token = await this.token();
    if (!token || /[\r\n]/u.test(token)) throw new Error('Forgejo credentials unavailable');
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ca: this.customCaPem ?? undefined,
          headers: {
            authorization: `token ${token}`,
            accept: 'application/json',
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            response.resume();
            reject(new ForgejoRequestError(status));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8_000_000) {
              response.destroy();
              reject(new Error('Forgejo response too large'));
            } else chunks.push(chunk);
          });
          response.on('error', () => reject(new Error('Forgejo response unavailable')));
          response.on('end', () => {
            try {
              resolve(
                (size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))) as T,
              );
            } catch {
              reject(new Error('Invalid Forgejo response'));
            }
          });
        },
      );
      const deadline = setTimeout(
        () => req.destroy(new Error('Forgejo request timed out')),
        15_000,
      );
      req.on('close', () => clearTimeout(deadline));
      req.on('error', (error: NodeJS.ErrnoException) => {
        const message =
          error.message === 'Forgejo request timed out'
            ? 'Forgejo request timed out'
            : /CERT|TLS|SSL|SELF_SIGNED|VERIFY_LEAF/u.test(error.code ?? '')
              ? 'Forgejo TLS certificate verification failed'
              : 'Forgejo connection unavailable';
        reject(new Error(message));
      });
      req.end(payload);
    });
  }

  async validate(): Promise<void> {
    const result = await this.json<{ data?: unknown }>('/repos/search?limit=1');
    if (!Array.isArray(result?.data)) throw new Error('Invalid Forgejo repository response');
    // Some public endpoints ignore credentials. Prove this endpoint actually
    // rejects an invalid token before treating a search result as validation.
    const probe = new ForgejoTransport(
      this.baseUrl,
      () => Promise.resolve(randomBytes(20).toString('hex')),
      this.customCaPem,
    );
    try {
      await probe.json('/repos/search?limit=1');
    } catch (error) {
      if (error instanceof ForgejoRequestError && [401, 403].includes(error.status)) return;
      throw error;
    }
    throw new Error('Forgejo endpoint does not verify token authentication');
  }

  async repositories(): Promise<{ owner: string; repo: string; archived: boolean }[]> {
    const repositories: { owner: string; repo: string; archived: boolean }[] = [];
    for (let page = 1; page <= 1000; page++) {
      const result = await this.json<{
        data: { owner?: { login?: unknown }; name?: unknown; archived?: boolean }[];
      }>(`/repos/search?page=${page}&limit=50`);
      const rows = result?.data;
      if (!Array.isArray(rows)) throw new Error('Invalid Forgejo repository response');
      for (const row of rows) {
        if (typeof row.owner?.login !== 'string' || typeof row.name !== 'string')
          throw new Error('Invalid Forgejo repository response');
        repositories.push({
          owner: row.owner.login.toLowerCase(),
          repo: row.name.toLowerCase(),
          archived: row.archived === true,
        });
      }
      if (rows.length === 0) return repositories;
    }
    throw new Error('Forgejo repository pagination limit exceeded');
  }
}
