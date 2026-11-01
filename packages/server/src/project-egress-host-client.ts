import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  projectEgressHostRequest,
  projectEgressHostResponse,
  type ProjectEgressHostRequest,
  type ProjectEgressHostResponse,
} from './project-egress-host.js';

/** Trusted Server transport only. A timeout has an unknown execution outcome:
 * never replay a command or fall back to direct Docker start after a failure.
 * The key and socket directory must not be exposed to project containers.
 */
export function createProjectEgressHostClient(options: {
  socketPath: string;
  token: string;
  timeoutMs?: number;
}): (input: ProjectEgressHostRequest) => Promise<ProjectEgressHostResponse> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (
    !isAbsolute(options.socketPath) ||
    !/^[a-f0-9]{64}$/u.test(options.token) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new Error('Invalid host control client configuration');
  return async (input) => {
    const command = projectEgressHostRequest.parse(input);
    const body = JSON.stringify(command);
    return new Promise<ProjectEgressHostResponse>((resolve, reject) => {
      const abort = new AbortController();
      // A total deadline, including response reads, not an inactivity timeout.
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      const fail = () => {
        clearTimeout(timer);
        abort.abort();
        reject(new Error('Host control operation failed; execution outcome may be unknown'));
      };
      const call = request(
        {
          socketPath: options.socketPath,
          path: '/v1/command',
          method: 'POST',
          agent: false,
          maxHeaderSize: 4096,
          signal: abort.signal,
          headers: {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            fail();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8192) {
              fail();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('end', () => {
            try {
              const result = projectEgressHostResponse.parse(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              );
              if (command.operation === 'current') {
                if (
                  result.state !== 'current' ||
                  result.projectId !== command.projectId ||
                  (result.binding !== null && result.binding.projectId !== command.projectId)
                )
                  throw new Error('Mismatched host binding');
              } else {
                const generation =
                  command.operation === 'register'
                    ? command.binding.generation
                    : command.generation;
                const expectedStates =
                  command.operation === 'start'
                    ? ['started-denied', 'started-connected']
                    : command.operation === 'connect'
                      ? ['connected']
                      : command.operation === 'refresh-direct'
                        ? ['direct-refreshed']
                        : command.operation === 'revoke-direct'
                          ? ['direct-revoked']
                          : command.operation === 'retire'
                            ? ['retired']
                            : ['denied'];
                if (
                  !expectedStates.includes(result.state) ||
                  result.state === 'current' ||
                  result.generation !== generation
                )
                  throw new Error('Mismatched host acknowledgement');
              }
              clearTimeout(timer);
              resolve(result);
            } catch {
              fail();
            }
          });
        },
      );
      call.on('error', fail);
      call.end(body);
    });
  };
}
