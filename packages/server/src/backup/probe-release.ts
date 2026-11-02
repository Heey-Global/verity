import { createReleaseChannelArtifactLoader } from '../self-update/release-channel-artifact.js';
import { parseSignedReleaseChannel } from '../self-update/release-channel.js';
import {
  createReleaseChannelVerifier,
  type ReleaseChannelVerifierOptions,
} from '../self-update/release-channel-verify.js';
import { captureMetadataSchema } from './capture-metadata.js';
import type { BackupProbeOptions } from './probe.js';

export interface ProbeReleaseOptions {
  /** Load the historical signed envelope for this digest, never substitute the current channel. */
  load?: (image: string, signal: AbortSignal) => Promise<unknown>;
  verification: ReleaseChannelVerifierOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Authenticate historical release metadata before staging or starting any snapshot image. */
export function createProbeReleaseCheck(
  options: ProbeReleaseOptions,
): BackupProbeOptions['checkRelease'] {
  const verify = createReleaseChannelVerifier(options.verification);
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    throw new Error('Invalid restore probe release timeout');
  return async (manifest, architecture) => {
    options.signal?.throwIfAborted();
    const capture = captureMetadataSchema.parse(manifest.capture);
    if (capture.architecture !== architecture || typeof manifest.schema !== 'string')
      throw new Error('Restore probe requires a native image and named schema');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('Restore probe release check aborted or timed out')),
          { once: true },
        );
        timer = setTimeout(abort, timeoutMs);
        if (options.signal?.aborted) abort();
      });
      const check = async () => {
        controller.signal.throwIfAborted();
        // Versioned candidates retain release evidence after the moving channel advances.
        const envelope = options.load
          ? await options.load(capture.image, controller.signal)
          : await createReleaseChannelArtifactLoader({
              architecture,
              tag: `candidate-stable-v${manifest.release}-${architecture}`,
            })(controller.signal);
        const signed = parseSignedReleaseChannel(envelope);
        controller.signal.throwIfAborted();
        if (!signed || !(await verify(signed)))
          throw new Error('Restore probe release signature invalid');
        controller.signal.throwIfAborted();
        const release = signed.metadata;
        if (
          release.serverImage !== capture.image ||
          release.architecture !== architecture ||
          release.version !== manifest.release ||
          release.compatibility.schema.current !== manifest.schema
        )
          throw new Error(
            'Signed release does not match the snapshot image, architecture, version or schema',
          );
      };
      await Promise.race([check(), stopped]);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  };
}
