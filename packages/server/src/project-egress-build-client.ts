import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  protectedBuildCommand,
  protectedBuildReply,
  type ProtectedBuildCommand,
  type ProtectedBuildReply,
} from './project-egress-build.js';

/** Transport failures may occur after the host committed an operation. */
export class ProtectedBuildTransportError extends Error {
  constructor() {
    super('Protected build control reply was not confirmed');
  }
}

/** Fixed authenticated operations on the private host-control socket. A retry
 * must retain the immutable attempt identity, including after a lost begin reply.
 */
export function createProtectedBuildClient(options: {
  socketPath: string;
  token: () => string;
  timeoutMs?: number;
}): (command: ProtectedBuildCommand) => Promise<ProtectedBuildReply> {
  const timeout = options.timeoutMs ?? 5000;
  if (
    !isAbsolute(options.socketPath) ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30000
  )
    throw new Error('Invalid protected build control configuration');
  return async (input) => {
    const command = protectedBuildCommand.parse(input);
    const token = options.token();
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Invalid protected build control key');
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (error?: unknown, reply?: ProtectedBuildReply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else if (reply !== undefined) resolve(reply);
      };
      const timer = setTimeout(() => {
        finish(new ProtectedBuildTransportError());
        abort.abort();
      }, timeout);
      const call = request(
        {
          socketPath: options.socketPath,
          path: '/v1/build',
          method: 'POST',
          agent: false,
          signal: abort.signal,
          maxHeaderSize: 4096,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32768) {
              finish(new Error('Protected build control response exceeded its limit'));
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(new ProtectedBuildTransportError()));
          response.on('aborted', () => finish(new ProtectedBuildTransportError()));
          response.on('end', () => {
            try {
              if (response.statusCode !== 200)
                throw new Error('Protected builder refused the operation');
              const reply = protectedBuildReply.parse(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              );
              if (command.operation === 'health') {
                if (!('available' in reply)) throw new Error('Mismatched protected builder health');
              } else {
                const expected = command.operation === 'begin' ? command.request : command;
                if (
                  !('record' in reply) ||
                  reply.record.request.projectId !== expected.projectId ||
                  reply.record.request.attemptId !== expected.attemptId
                )
                  throw new Error('Mismatched protected build acknowledgement');
                if (
                  command.operation === 'begin' &&
                  JSON.stringify(reply.record.request) !== JSON.stringify(command.request)
                )
                  throw new Error('Changed protected build acknowledgement');
              }
              finish(undefined, reply);
            } catch (error) {
              finish(error);
            }
          });
        },
      );
      call.on('error', () => finish(new ProtectedBuildTransportError()));
      call.end(JSON.stringify(command));
    });
  };
}
