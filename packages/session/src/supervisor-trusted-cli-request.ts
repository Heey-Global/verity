import { createConnection } from 'node:net';
import type { TrustedCliOutputSink } from './runner-supervisor-client.js';

// One trusted CLI request to the runner supervisor, over its socket.

export async function requestSupervisorTrustedCli(
  socketPath: string,
  request: Record<string, unknown>,
  timeouts: { startAckTimeoutMs: number; resultTimeoutMs: number; onOutput?: TrustedCliOutputSink },
): Promise<Record<string, unknown>> {
  const frame = `${JSON.stringify({ protocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION, ...request })}\n`;
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let started = false;
    let outputPending = false;
    let outputSequence = 0;
    let timeout = setTimeout(
      () => finish(new Error('trusted CLI start acknowledgement timed out')),
      timeouts.startAckTimeoutMs,
    );
    const finish = (error?: Error, response?: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(new SupervisorTrustedCliRequestError(error, started));
      else resolve(response ?? {});
    };
    const armResultTimeout = (): void => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () => finish(new Error('trusted CLI result response timed out')),
        timeouts.resultTimeoutMs,
      );
      timeout.unref?.();
    };
    timeout.unref?.();
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(frame));
    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
        finish(new Error('runner supervisor response too large'));
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          finish(new Error('runner supervisor returned malformed JSON'));
          return;
        }
        if (!isObject(parsed) || parsed.ok !== true) {
          const reason =
            isObject(parsed) && typeof parsed.error === 'string' && parsed.error !== ''
              ? parsed.error
              : undefined;
          const rejection = new Error(
            reason === undefined
              ? 'runner supervisor rejected request'
              : `runner supervisor rejected request: ${reason}`,
          );
          if (isObject(parsed) && isObject(parsed.trustedCliFailure)) {
            Object.assign(rejection, { trustedCliFailure: parsed.trustedCliFailure });
          }
          finish(rejection);
          return;
        }
        if (parsed.kind === 'trusted-cli-output') {
          if (
            !started ||
            timeouts.onOutput === undefined ||
            outputPending ||
            parsed.sequence !== outputSequence ||
            (parsed.stream !== 'stdout' && parsed.stream !== 'stderr') ||
            typeof parsed.data !== 'string' ||
            parsed.data.length > 21848 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(parsed.data)
          ) {
            finish(new Error('invalid trusted CLI output frame'));
            return;
          }
          const bytes = Buffer.from(parsed.data, 'base64');
          if (bytes.toString('base64') !== parsed.data) {
            finish(new Error('invalid trusted CLI output encoding'));
            return;
          }
          outputPending = true;
          socket.pause();
          const sequence = outputSequence++;
          void Promise.resolve()
            .then(() => timeouts.onOutput!(parsed.stream as 'stdout' | 'stderr', bytes))
            .then(
              () => {
                if (!settled) socket.write(`${JSON.stringify({ kind: 'output-ack', sequence })}\n`);
              },
              (error: unknown) => {
                const reason =
                  isObject(error) &&
                  ['redaction_failure', 'output_limit'].includes(String(error.outputFailure))
                    ? error.outputFailure
                    : 'storage_failure';
                if (!settled)
                  socket.write(
                    `${JSON.stringify({ kind: 'output-ack', sequence, failure: reason })}\n`,
                  );
              },
            )
            .finally(() => {
              bytes.fill(0);
              outputPending = false;
              if (!settled) socket.resume();
            });
          // Stop-and-wait forbids a terminal frame before persistence acknowledgment.
          if (buffer.length > 0) finish(new Error('pipelined trusted CLI output'));
          return;
        }
        if (parsed.kind === 'trusted-cli-started') {
          if (started) {
            finish(
              new Error('runner supervisor returned duplicate trusted CLI start acknowledgement'),
            );
            return;
          }
          started = true;
          armResultTimeout();
          continue;
        }
        // A fast command can finish before the start frame and an old supervisor
        // sends only this final response. Both are safe successful compatibility
        // cases; a long-running old supervisor instead reaches the bounded ack
        // timeout and is reported with an unknown execution state.
        finish(undefined, parsed);
        return;
      }
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('runner supervisor closed before trusted CLI result'));
    });
  });
}

/**
 * The oldest Runner protocol this Server still reads — ADR 0006 D9.
 *
 * D9 requires each Server release to support the immediately previous Runner
 * protocol, because a Server update routinely meets a Runner started from the
 * release before it. Strict equality would make the first genuine version bump a
 * fleet-wide outage: every already-running Sandbox would stop being readable the
 * moment the Server rolled, which is exactly the class of failure D9 forbids.
 *
 * Equal to {@link PROTOCOL_VERSION} today, so this changes no behaviour. That is
 * the point of adding it before it is needed — raising the version then means
 * deciding how far back to keep reading, rather than discovering that the range
 * D9 prescribes was never implemented.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

export const MAX_RESPONSE_BYTES = 64 * 1024;

export class SupervisorTrustedCliRequestError extends Error {
  constructor(
    override readonly cause: Error,
    readonly startAcknowledged: boolean,
  ) {
    super(cause.message, { cause });
    this.name = 'SupervisorTrustedCliRequestError';
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
