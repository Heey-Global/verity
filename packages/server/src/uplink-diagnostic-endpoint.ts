import { UPLINK_CONTROL_URL } from './uplink-control-client.js';

/** A diagnostic endpoint must never silently select a different installation. */
export function uplinkDiagnosticEndpoint(env: NodeJS.ProcessEnv): {
  uplinkUrl: string;
  expectedInstallationId?: string;
} {
  const origin = env.VERITY_DIAGNOSTIC_UPLINK_ORIGIN;
  const installationId = env.VERITY_DIAGNOSTIC_UPLINK_INSTALLATION_ID;
  if (origin === undefined && installationId === undefined) {
    return { uplinkUrl: UPLINK_CONTROL_URL };
  }
  if (!origin || !installationId || installationId.trim() !== installationId) {
    throw new Error('diagnostic Uplink requires an HTTPS origin and an existing installation ID');
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('diagnostic Uplink requires an HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('diagnostic Uplink requires an HTTPS origin without credentials or suffixes');
  }
  url.protocol = 'wss:';
  url.pathname = '/control';
  return { uplinkUrl: url.href, expectedInstallationId: installationId };
}
