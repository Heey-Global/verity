import { PreviewEdge } from './index.js';

const maxBodyBytes = optionalPositiveInteger('VERITY_PREVIEW_MAX_BODY_BYTES');
const requestTimeoutMs = optionalPositiveInteger('VERITY_PREVIEW_REQUEST_TIMEOUT_MS');
const trustedProxyHops = optionalPositiveInteger('VERITY_PREVIEW_TRUSTED_PROXY_HOPS');
const edge = new PreviewEdge({
  shareId: required('VERITY_PREVIEW_SHARE_ID'),
  pinHash: required('VERITY_PREVIEW_PIN_HASH'),
  connectorTokenHash: required('VERITY_PREVIEW_CONNECTOR_TOKEN_HASH'),
  sessionSecretHash: required('VERITY_PREVIEW_SESSION_SECRET_HASH'),
  publicOrigin: required('VERITY_PREVIEW_PUBLIC_ORIGIN'),
  expiresAt: required('VERITY_PREVIEW_EXPIRES_AT'),
  ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
  ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
});

const port = optionalPositiveInteger('PORT') ?? 8080;
await edge.listen(port, '0.0.0.0');
process.stdout.write(`preview edge listening on :${port}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void edge.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `preview edge shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}
