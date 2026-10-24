import { VerityClient } from '@verity/mobile';
import { createPinnedFetch } from './pinnedTransport';
import type { RemoteAdmissionOptions } from './remoteControlAdmission';

/** Direct paired-admin channel: arming must never recursively open App DATA. */
export function createPairedSelectedRecordingArming(input: {
  coreUrl: string;
  corePin: string;
  getToken: () => string | null | undefined;
  runId: string;
  installationFingerprint: string;
  durationMs: number;
}): NonNullable<RemoteAdmissionOptions['diagnosticArming']> {
  const url = new URL(input.coreUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Selected recording requires an independent paired HTTPS Core origin.');
  const client = new VerityClient({
    baseUrl: url.origin,
    fetch: createPinnedFetch(input.corePin, false),
    getToken: input.getToken,
  });
  return {
    runId: input.runId,
    installationFingerprint: input.installationFingerprint,
    arm: (sessionId, signal) =>
      client.startSelectedConnectionRecording(input.runId, input.durationMs, sessionId, signal),
  };
}
