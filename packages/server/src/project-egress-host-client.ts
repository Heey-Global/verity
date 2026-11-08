import { DockerError, DOCKER_ADDRESS_POOL_EXHAUSTED } from './docker.js';
import {
  inventoryFailureReason,
  ProjectEgressInventoryError,
} from './project-egress-inventory-error.js';
import { request } from 'node:http';
import {
  ProjectEgressHealthError,
  type ProjectEgressHealthReason,
} from './project-egress-health.js';
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
  token: string | (() => string);
  timeoutMs?: number;
}): (input: ProjectEgressHostRequest) => Promise<ProjectEgressHostResponse> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (
    !isAbsolute(options.socketPath) ||
    (typeof options.token === 'string' && !/^[a-f0-9]{64}$/u.test(options.token)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new ProjectEgressHealthError('invalid_configuration');
  return async (input) => {
    let token: string;
    try {
      token = typeof options.token === 'function' ? options.token() : options.token;
    } catch {
      throw new ProjectEgressHealthError('key_unreadable');
    }
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new ProjectEgressHealthError('invalid_configuration');
    const command = projectEgressHostRequest.parse(input);
    const body = JSON.stringify(command);
    return new Promise<ProjectEgressHostResponse>((resolve, reject) => {
      const abort = new AbortController();
      // A total deadline, including response reads, not an inactivity timeout.
      const timer = setTimeout(() => fail('timeout'), timeoutMs);
      const fail = (reason: ProjectEgressHealthReason) => {
        clearTimeout(timer);
        abort.abort();
        reject(new ProjectEgressHealthError(reason));
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
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          if (response.statusCode !== 200 && response.statusCode !== 409) {
            fail(response.statusCode === 401 ? 'authentication_failed' : 'host_not_ready');
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8192) {
              fail('protocol_mismatch');
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => fail('service_unreachable'));
          response.on('end', () => {
            try {
              if (response.statusCode === 409) {
                const refused: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                const reason =
                  typeof refused === 'object' && refused !== null && 'reason' in refused
                    ? refused.reason
                    : undefined;
                if (
                  command.operation === 'allocate-network' &&
                  reason === 'address_pool_exhausted'
                ) {
                  clearTimeout(timer);
                  abort.abort();
                  reject(
                    new DockerError({
                      kind: 'address_pool_exhausted',
                      message: DOCKER_ADDRESS_POOL_EXHAUSTED,
                    }),
                  );
                  return;
                }
                const inventoryReason = inventoryFailureReason(reason);
                if (command.operation.startsWith('inventory-') && inventoryReason) {
                  clearTimeout(timer);
                  abort.abort();
                  const correlationId =
                    typeof refused === 'object' &&
                    refused !== null &&
                    'correlationId' in refused &&
                    typeof refused.correlationId === 'string' &&
                    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
                      refused.correlationId,
                    )
                      ? refused.correlationId
                      : undefined;
                  reject(new ProjectEgressInventoryError(inventoryReason, correlationId));
                  return;
                }
                fail(
                  command.operation === 'health' && reason === 'mandatory_inventory_incomplete'
                    ? reason
                    : 'host_not_ready',
                );
                return;
              }
              const result = projectEgressHostResponse.parse(
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              );
              if (
                command.operation === 'inventory-begin' ||
                command.operation === 'inventory-abort' ||
                command.operation === 'inventory-commit' ||
                command.operation === 'inventory-renew'
              ) {
                if (
                  !('token' in result) ||
                  result.state !==
                    (command.operation === 'inventory-abort'
                      ? 'inventory-aborted'
                      : command.operation === 'inventory-begin'
                        ? 'inventory-denied'
                        : 'inventory-ready') ||
                  result.token !== command.token
                )
                  throw new Error('Mismatched inventory acknowledgement');
              } else if (command.operation === 'health') {
                if (result.state !== 'health') throw new Error('Mismatched host health');
              } else if (command.operation === 'allocate-network') {
                if (
                  result.state !== 'network-allocated' ||
                  result.binding.projectId !== command.projectId ||
                  result.binding.generation !== command.generation
                )
                  throw new Error('Mismatched host allocation');
              } else if (command.operation === 'current') {
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
                            : command.operation === 'resolve-direct'
                              ? ['resolved', 'unresolved']
                              : ['denied'];
                if (
                  !expectedStates.includes(result.state) ||
                  result.state === 'current' ||
                  result.state === 'health' ||
                  result.state === 'inventory-denied' ||
                  result.state === 'inventory-ready' ||
                  !('generation' in result) ||
                  result.generation !== generation
                )
                  throw new Error('Mismatched host acknowledgement');
              }
              clearTimeout(timer);
              resolve(result);
            } catch {
              fail('protocol_mismatch');
            }
          });
        },
      );
      call.on('error', (error: NodeJS.ErrnoException) =>
        fail(
          error.code === 'ENOENT'
            ? 'socket_missing'
            : error.code === 'EACCES' || error.code === 'EPERM'
              ? 'permission_denied'
              : 'service_unreachable',
        ),
      );
      call.end(body);
    });
  };
}
