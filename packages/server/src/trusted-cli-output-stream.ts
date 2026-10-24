import { createHash } from 'node:crypto';
import {
  StreamingSecretRedactor,
  RedactionLimitError,
  type StreamingRedactorProfile,
} from '@verity/secret-contracts';
import type { TrustedCliToolResult } from './trusted-cli-tool.js';
import {
  TRUSTED_OUTPUT_BYTES,
  type OutputOwner,
  type TrustedCliOutputStore,
} from './trusted-cli-output.js';

export type TrustedCliOutputOptions = {
  onOutput: (stream: 'stdout' | 'stderr', bytes: Uint8Array) => Promise<void>;
};

/** Return no stream adapter when the legacy secret domain exceeds the bounded redactor profile. */
export function createTrustedCliOutputRedactors(secrets: readonly Uint8Array[]) {
  if (secrets.some((secret) => secret.length < 4 || secret.length > 4096)) return undefined;
  const variants = new Map<string, Uint8Array>();
  for (const secret of secrets) {
    variants.set(Buffer.from(secret).toString('hex'), new Uint8Array(secret));
    const text = new TextDecoder().decode(secret);
    const wire = Buffer.from(secret).toString('base64');
    // File credentials can be echoed as bytes or as their transport base64 value.
    for (const value of [text, wire]) {
      for (const encoded of [
        value,
        Buffer.from(value).toString('base64'),
        encodeURIComponent(value),
      ]) {
        const bytes = Buffer.from(encoded);
        variants.set(bytes.toString('hex'), bytes);
      }
    }
  }
  const patterns = [...variants.values()];
  if (
    patterns.length === 0 ||
    patterns.length > 64 ||
    patterns.some((p) => p.length < 4 || p.length > 4096)
  ) {
    for (const pattern of patterns) pattern.fill(0);
    return undefined;
  }
  const profile: StreamingRedactorProfile = {
    id: 'trusted-cli-output-v1',
    version: 1,
    implementationDigest: createHash('sha256').update('byte-longest-first-v1').digest('hex'),
    algorithm: 'byte-longest-first-v1',
    minimumSecretBytes: 4,
    maximumSecretBytes: Math.max(...patterns.map((p) => p.length)),
    maximumActiveSecrets: 64,
    maximumInputChunkBytes: 65536,
    maximumScanComparisons: 8388608,
    maximumOutputBytes: TRUSTED_OUTPUT_BYTES,
    replacement: '[REDACTED]',
  };
  let stdout: StreamingSecretRedactor | undefined;
  try {
    stdout = new StreamingSecretRedactor(profile, patterns);
    return { stdout, stderr: new StreamingSecretRedactor(profile, patterns) };
  } catch (error) {
    stdout?.dispose();
    throw error;
  } finally {
    for (const pattern of patterns) pattern.fill(0);
  }
}

/**
 * Raw pipe bytes arrive only over the privileged supervisor/server socket. The server already
 * resolves the invocation's secrets; agents never see this callback or its input. Only redacted,
 * UTF-8-decoded text reaches the encrypted spool or inline response. ACK backpressure bounds
 * redactor and batch buffers; acknowledgement alone is not a durable output receipt.
 */
export async function collectTrustedCliOutput(
  store: TrustedCliOutputStore,
  owner: OutputOwner,
  redactors: NonNullable<ReturnType<typeof createTrustedCliOutputRedactors>>,
  execute: (options: TrustedCliOutputOptions) => Promise<TrustedCliToolResult>,
): Promise<TrustedCliToolResult> {
  let id: string;
  try {
    id = await store.begin(owner);
  } catch (error) {
    redactors.stdout.dispose();
    redactors.stderr.dispose();
    throw error;
  }
  const decoders = {
    stdout: new TextDecoder('utf-8', { fatal: true }),
    stderr: new TextDecoder('utf-8', { fatal: true }),
  };
  const preview = { stdout: '', stderr: '' };
  const pending = { stdout: '', stderr: '' };
  let receivedOutput = false;
  let previewFull = false;
  let totalBytes = 0;
  let failure: 'redaction_failure' | 'storage_failure' | 'output_limit' | undefined;
  const safeError = (reason: NonNullable<typeof failure>) =>
    Object.assign(new Error('trusted CLI output processing failed'), { outputFailure: reason });
  const persist = async (stream: 'stdout' | 'stderr', bytes: Uint8Array, final = false) => {
    let text;
    try {
      text = decoders[stream].decode(bytes, { stream: !final });
    } catch {
      failure = 'redaction_failure';
      throw safeError(failure);
    }
    const size = Buffer.byteLength(text);
    if (totalBytes + size > TRUSTED_OUTPUT_BYTES) {
      failure = 'output_limit';
      throw safeError(failure);
    }
    totalBytes += size;
    pending[stream] += text;
    if (!final && pending[stream].length < 3072) return;
    const ready = pending[stream];
    pending[stream] = '';
    try {
      await store.append(id, stream, ready);
    } catch {
      failure = 'storage_failure';
      throw safeError(failure);
    }
    if (!previewFull) {
      let part = ready.slice(0, 20000);
      while (
        Buffer.byteLength(JSON.stringify({ ...preview, [stream]: preview[stream] + part })) > 20000
      )
        part = part.slice(0, Math.floor(part.length / 2));
      if (/[\uD800-\uDBFF]$/u.test(part)) part = part.slice(0, -1);
      preview[stream] += part;
      previewFull = part.length !== ready.length;
    }
  };
  try {
    let result: TrustedCliToolResult;
    try {
      result = await execute({
        onOutput: async (stream, bytes) => {
          receivedOutput = true;
          if (failure !== undefined) throw safeError(failure);
          for (let offset = 0; offset < bytes.length; offset += 16384) {
            let redacted;
            try {
              redacted = redactors[stream].push(bytes.subarray(offset, offset + 16384));
            } catch (error) {
              failure =
                error instanceof RedactionLimitError && error.reason === 'output_limit'
                  ? 'output_limit'
                  : 'redaction_failure';
              throw safeError(failure);
            }
            await persist(stream, redacted);
          }
        },
      });
    } catch (error) {
      if (!receivedOutput && failure === undefined) {
        await store.remove(id);
        throw error;
      }
      result = {
        exitCode: 1,
        exitCodeKnown: false,
        stdout: '',
        stderr: '',
        outputMode: 'stream-v1',
        terminationReason: failure ?? 'transport_failure',
      };
    }
    if (result.outputMode !== 'stream-v1') {
      await store.remove(id);
      return result;
    }
    if (
      failure === undefined &&
      result.terminationReason === 'process_exit' &&
      result.exitCodeKnown !== false
    ) {
      try {
        for (const stream of ['stdout', 'stderr'] as const)
          await persist(stream, redactors[stream].flush(), true);
      } catch {
        failure ??= 'redaction_failure';
      }
    }
    // Safe decoded batches survive abnormal termination; unresolved decoder/redactor tails do not.
    if (failure !== 'storage_failure') {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (pending[stream].length === 0) continue;
        try {
          await store.append(id, stream, pending[stream]);
          pending[stream] = '';
        } catch {
          failure = 'storage_failure';
          break;
        }
      }
    }
    const metadata: TrustedCliToolResult = {
      ...result,
      stdout: '',
      stderr: '',
      ...(failure === undefined
        ? {}
        : { terminationReason: failure, exitCode: 1, exitCodeKnown: false }),
    };
    if (
      failure === undefined &&
      result.terminationReason === 'process_exit' &&
      totalBytes === Buffer.byteLength(preview.stdout + preview.stderr)
    ) {
      await store.remove(id);
      return { ...metadata, stdout: preview.stdout, stderr: preview.stderr };
    }
    try {
      await store.finish(id, metadata);
    } catch {
      return {
        ...metadata,
        stdout: preview.stdout,
        stderr: preview.stderr,
        terminationReason: 'storage_failure',
        invocationId: id,
        exitCode: 1,
        exitCodeKnown: false,
      };
    }
    return {
      ...metadata,
      stdout: preview.stdout,
      stderr: preview.stderr,
      invocationId: id,
      outputAvailable: true,
      ...(totalBytes > Buffer.byteLength(preview.stdout + preview.stderr)
        ? { previewTruncated: true }
        : {}),
    };
  } finally {
    redactors.stdout.dispose();
    redactors.stderr.dispose();
  }
}
