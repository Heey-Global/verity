import { canonicalJson } from '@verity/secret-contracts';
import { z } from 'zod';

const DOCKER_HEADER_BYTES = 8;
export const MAX_DOCKER_ATTACH_FRAME_BYTES = 1_048_576;
export const MAX_WORKER_MESSAGE_BYTES = 262_144;

export class SecretWorkerProtocolError extends Error {}

export interface DockerAttachFrame {
  stream: 'stdout' | 'stderr';
  payload: Uint8Array;
}

export const secretWorkerWireMessageSchema = z
  .object({
    protocolVersion: z.literal(1),
    type: z.enum(['challenge', 'proof', 'bootstrap', 'frame', 'result', 'error']),
    payload: z.unknown(),
  })
  .strict();
export type SecretWorkerWireMessage = z.infer<typeof secretWorkerWireMessageSchema>;

/** Decode Docker's non-TTY 8-byte multiplex header across arbitrary transport chunk boundaries. */
export async function* decodeDockerAttachFrames(
  source: AsyncIterable<Uint8Array>,
  maximumFrameBytes = MAX_DOCKER_ATTACH_FRAME_BYTES,
): AsyncGenerator<DockerAttachFrame> {
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes <= 0) {
    throw new Error('maximum Docker attach frame bytes must be positive');
  }
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const capacity = maximumFrameBytes + DOCKER_HEADER_BYTES - buffer.length;
      const take = Math.min(capacity, chunk.byteLength - offset);
      if (take <= 0) throw new SecretWorkerProtocolError('worker protocol buffer limit exceeded');
      buffer = Buffer.concat([buffer, Buffer.from(chunk.subarray(offset, offset + take))]);
      offset += take;
      while (buffer.length >= DOCKER_HEADER_BYTES) {
        const streamId = buffer[0];
        if (streamId !== 1 && streamId !== 2) {
          throw new SecretWorkerProtocolError('invalid Docker attach stream id');
        }
        if (buffer[1] !== 0 || buffer[2] !== 0 || buffer[3] !== 0) {
          throw new SecretWorkerProtocolError('invalid Docker attach reserved header bytes');
        }
        const length = buffer.readUInt32BE(4);
        if (length > maximumFrameBytes) {
          throw new SecretWorkerProtocolError('Docker attach frame exceeds limit');
        }
        if (buffer.length < DOCKER_HEADER_BYTES + length) break;
        const payload = Buffer.from(
          buffer.subarray(DOCKER_HEADER_BYTES, DOCKER_HEADER_BYTES + length),
        );
        buffer = buffer.subarray(DOCKER_HEADER_BYTES + length);
        yield { stream: streamId === 1 ? 'stdout' : 'stderr', payload };
      }
    }
  }
  if (buffer.length !== 0) throw new SecretWorkerProtocolError('truncated Docker attach frame');
}

/** Deterministic 4-byte big-endian length prefix followed by canonical UTF-8 JSON. */
export function encodeSecretWorkerMessage(message: SecretWorkerWireMessage): Buffer {
  const parsed = secretWorkerWireMessageSchema.parse(message);
  const body = Buffer.from(canonicalJson(parsed), 'utf8');
  if (body.length > MAX_WORKER_MESSAGE_BYTES) {
    throw new SecretWorkerProtocolError('worker message exceeds limit');
  }
  const output = Buffer.allocUnsafe(4 + body.length);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

/** Decode worker messages across arbitrary Docker stdout-frame boundaries. */
export async function* decodeSecretWorkerMessages(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<SecretWorkerWireMessage> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const capacity = MAX_WORKER_MESSAGE_BYTES + 4 - buffer.length;
      const take = Math.min(capacity, chunk.byteLength - offset);
      if (take <= 0) throw new SecretWorkerProtocolError('worker protocol buffer limit exceeded');
      buffer = Buffer.concat([buffer, Buffer.from(chunk.subarray(offset, offset + take))]);
      offset += take;
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0 || length > MAX_WORKER_MESSAGE_BYTES) {
          throw new SecretWorkerProtocolError('invalid worker message length');
        }
        if (buffer.length < 4 + length) break;
        const body = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
        } catch {
          throw new SecretWorkerProtocolError('invalid worker message JSON or UTF-8');
        }
        const parsed = secretWorkerWireMessageSchema.safeParse(decoded);
        if (!parsed.success) throw new SecretWorkerProtocolError('invalid worker message shape');
        yield parsed.data;
      }
    }
  }
  if (buffer.length !== 0) throw new SecretWorkerProtocolError('truncated worker message');
}
