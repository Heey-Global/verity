import { CONNECTOR_MAX_RECONNECT_ATTEMPTS, PreviewConnector, reconnectDelayMs } from './index.js';
import { startStaticPreviewServer } from './static-server.js';

const maxBodyBytes = optionalPositiveInteger('VERITY_PREVIEW_MAX_BODY_BYTES');
const requestTimeoutMs = optionalPositiveInteger('VERITY_PREVIEW_REQUEST_TIMEOUT_MS');
const staticRoot = process.env.VERITY_PREVIEW_STATIC_ROOT?.trim();
const staticServer = staticRoot
  ? await startStaticPreviewServer(staticRoot, required('VERITY_PREVIEW_STATIC_PATH'))
  : undefined;
const connector = new PreviewConnector({
  edgeUrl: required('VERITY_PREVIEW_EDGE_URL'),
  connectorToken: required('VERITY_PREVIEW_CONNECTOR_TOKEN'),
  targetOrigin: staticServer?.origin ?? required('VERITY_PREVIEW_TARGET_ORIGIN'),
  ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    connector.close();
    void staticServer?.close();
  });
}

let attempt = 0;
while (!stopping) {
  try {
    await connector.connect();
    attempt = 0;
    process.stdout.write('preview connector established\n');
    await connector.waitForDisconnect();
    if (stopping) break;
    process.stderr.write('preview connector disconnected; reconnecting\n');
  } catch (error) {
    if (stopping) break;
    attempt += 1;
    if (attempt >= CONNECTOR_MAX_RECONNECT_ATTEMPTS) throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(attempt)));
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
