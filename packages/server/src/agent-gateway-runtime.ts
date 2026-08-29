import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

import {
  startAgentGatewayControlServer,
  type AgentGatewayConfiguration,
  type AgentGatewayStatus,
  type CodexCredentialUpdate,
} from './agent-gateway-control.js';
import { buildClaudeEgressPeerBindings } from './claude-egress-mtls.js';
import {
  authenticateClaudeEgressPeer,
  claudeEgressMtlsServerOptions,
  startClaudeEgressMtlsGateway,
  type ClaudeEgressMtlsGateway,
  type ClaudeEgressMtlsGatewayOptions,
} from './claude-egress-mtls.js';
import { ClaudeEgressCredentialUnavailableError } from './claude-egress-policy.js';
import type {
  ClaudeEgressRequestEnd,
  ClaudeEgressRequestObserver,
} from './claude-egress-gateway.js';
import { AgentGatewaySpill } from './agent-gateway-spill.js';
import { CodexCredentialAuthority } from './codex-credential-authority.js';
import { CodexCredentialUnavailableError } from './codex-sign-in-error.js';
import { CodexCredentialSpill } from './codex-credential-spill.js';
import {
  startCodexEgressGateway,
  type CodexEgressGateway,
  type CodexEgressGatewayOptions,
  type CodexEgressRequestEnd,
  type CodexEgressRequestObserver,
} from './codex-egress-gateway.js';

export interface AgentGatewayRuntime {
  readonly healthPort: number;
  status(): AgentGatewayStatus;
  close(): Promise<void>;
}

export async function startAgentGatewayRuntime(options: {
  controlSocketPath: string;
  healthPort: number;
  healthHost?: string;
  claudePort: number;
  claudeHost?: string;
  claudeListenerAuthority: string;
  spillPath: string;
  codexPort?: number;
  codexHost?: string;
  codexListenerAuthority?: string;
  codexSpillPath?: string;
  startClaudeGateway?: (
    options: ClaudeEgressMtlsGatewayOptions,
  ) => Promise<ClaudeEgressMtlsGateway>;
  /** Override where finished Claude egress requests are recorded (tests, or a
   *  deployment that must not write them at all: pass `() => {}`). */
  onClaudeRequestEnd?: ClaudeEgressRequestObserver;
  /** Override where finished Codex egress requests are recorded. */
  onCodexRequestEnd?: CodexEgressRequestObserver;
  startCodexGateway?: (options: CodexEgressGatewayOptions) => Promise<CodexEgressGateway>;
}): Promise<AgentGatewayRuntime> {
  let configuration: AgentGatewayConfiguration | undefined;
  let accessToken: string | undefined;
  let spillKey: string | undefined;
  let listener: ClaudeEgressMtlsGateway | undefined;
  let codexAuthority: CodexCredentialAuthority | undefined;
  let codexSpillKey: string | undefined;
  let codexListener: CodexEgressGateway | undefined;
  let codexSourceRevision: string | undefined;
  let pendingCodexUpdate: CodexCredentialUpdate | undefined;
  let claudeRequired = false;
  let codexRequired = false;
  let peerBindings = new Map<string, string>();
  const spill = new AgentGatewaySpill(options.spillPath);
  const codexSpill = new CodexCredentialSpill(
    options.codexSpillPath ?? `${options.spillPath}.codex`,
  );
  const startGateway = options.startClaudeGateway ?? startClaudeEgressMtlsGateway;
  const startCodexGateway = options.startCodexGateway ?? startCodexEgressGateway;
  const status = (): AgentGatewayStatus => ({
    ready: true,
    configured: configuration !== undefined,
    ...(configuration === undefined ? {} : { revision: configuration.revision }),
    claudePeerCount: configuration?.claude.peerBindings.length ?? 0,
    credentialReady: accessToken !== undefined,
    listenerReady: listener !== undefined,
    ...(listener === undefined ? {} : { claudePort: listener.port }),
    ...(configuration?.codex === undefined &&
    codexAuthority === undefined &&
    codexListener === undefined
      ? {}
      : {
          codexCredentialReady: codexAuthority !== undefined,
          codexListenerReady: codexListener !== undefined,
          ...(codexListener === undefined ? {} : { codexPort: codexListener.port }),
        }),
  });
  const control = await startAgentGatewayControlServer({
    socketPath: options.controlSocketPath,
    async configure(next): Promise<void> {
      const nextBindings = buildClaudeEgressPeerBindings(next.claude.peerBindings);
      const previousCodexSnapshot = codexAuthority?.snapshot();
      const previousCodexSpillKey = codexSpillKey;
      const previousCodexSourceRevision = codexSourceRevision;
      const previousPendingCodexUpdate = pendingCodexUpdate;
      let nextCodexAuthority: CodexCredentialAuthority | undefined;
      const nextCodexCredential = next.codex?.credential;
      if (nextCodexCredential !== undefined && nextCodexCredential.authJson !== null) {
        const recovered = await codexSpill.read(nextCodexCredential.unsealKey);
        const sameSource = nextCodexCredential.sourceRevision === codexSourceRevision;
        const recoverable = recovered?.sourceRevision === nextCodexCredential.sourceRevision;
        const authJson =
          (sameSource ? codexAuthority?.snapshot() : undefined) ??
          (recoverable ? recovered.authJson : undefined) ??
          nextCodexCredential.authJson;
        if (authJson !== undefined) {
          if (!sameSource && !recoverable) {
            await codexSpill.write(
              nextCodexCredential.unsealKey,
              nextCodexCredential.sourceRevision,
              authJson,
            );
          }
          nextCodexAuthority = new CodexCredentialAuthority(authJson, {
            persist: async (updated) => {
              await codexSpill.write(
                nextCodexCredential.unsealKey,
                nextCodexCredential.sourceRevision,
                updated,
              );
              pendingCodexUpdate = {
                sourceRevision: nextCodexCredential.sourceRevision,
                updatedRevision: createHash('sha256').update(updated).digest('hex'),
                authJson: updated,
              };
            },
          });
          if (recoverable && recovered.authJson !== nextCodexCredential.authJson) {
            pendingCodexUpdate = {
              sourceRevision: recovered.sourceRevision,
              updatedRevision: createHash('sha256').update(recovered.authJson).digest('hex'),
              authJson: recovered.authJson,
            };
          }
        }
      }
      let nextToken = accessToken;
      const credential = next.claude.credential;
      const nextSpillKey = credential?.unsealKey ?? spillKey;
      if (credential === undefined || credential.accessToken === null) {
        nextToken = undefined;
      } else if (credential?.accessToken !== undefined && credential.accessToken !== null) {
        nextToken = credential.accessToken;
      } else if (credential !== undefined) {
        nextToken = await spill.unseal(credential.unsealKey);
      }

      let spillMutated = false;
      const revoking = credential === undefined || credential.accessToken === null;
      if (revoking) {
        await spill.clear();
        spillMutated = true;
        // Revocation is fail-closed and independent of TLS convergence. A reload
        // failure must never resurrect the credential that was just withdrawn.
        accessToken = undefined;
        spillKey = credential?.unsealKey;
      } else if (credential.accessToken !== undefined && credential.accessToken !== null) {
        await spill.unseal(credential.unsealKey, credential.accessToken);
        spillMutated = true;
      }

      const previousBindings = peerBindings;
      const previousToken = accessToken;
      const previousSpillKey = spillKey;
      const previousCodexAuthority = codexAuthority;
      try {
        // Listener callbacks close over these mutable authority slots. Install
        // the candidate before a first listener can accept traffic; rollback
        // restores the previous authority if any later configuration step fails.
        codexAuthority = nextCodexAuthority;
        if (
          nextCodexCredential?.sourceRevision !== codexSourceRevision &&
          pendingCodexUpdate?.sourceRevision !== nextCodexCredential?.sourceRevision
        ) {
          pendingCodexUpdate = undefined;
        }
        codexSourceRevision = nextCodexCredential?.sourceRevision;
        codexSpillKey = nextCodexCredential?.unsealKey;
        if (listener !== undefined) listener.reloadTls(next.claude.tls);
        if (codexListener !== undefined)
          codexListener.reloadTls(claudeEgressMtlsServerOptions(next.claude.tls));
        if (listener === undefined && nextToken !== undefined) {
          peerBindings = nextBindings;
          accessToken = nextToken;
          listener = await startGateway({
            port: options.claudePort,
            host: options.claudeHost ?? '127.0.0.1',
            listenerAuthority: options.claudeListenerAuthority,
            tls: next.claude.tls,
            authenticatePeer: (socket): string | undefined =>
              authenticateClaudeEgressPeer(socket, peerBindings),
            accessToken: (): Promise<string> => {
              if (accessToken === undefined) {
                return Promise.reject(
                  new ClaudeEgressCredentialUnavailableError(
                    'Claude egress has no OAuth token configured',
                  ),
                );
              }
              return Promise.resolve(accessToken);
            },
            onRequestEnd: options.onClaudeRequestEnd ?? logClaudeEgressRequestEnd,
          });
        }
        if (
          codexListener === undefined &&
          nextCodexAuthority !== undefined &&
          options.codexPort !== undefined &&
          options.codexListenerAuthority !== undefined
        ) {
          codexListener = await startCodexGateway({
            port: options.codexPort,
            host: options.codexHost ?? '127.0.0.1',
            listenerAuthority: options.codexListenerAuthority,
            tls: claudeEgressMtlsServerOptions(next.claude.tls),
            authenticatePeer: (socket): string | undefined =>
              authenticateClaudeEgressPeer(socket, peerBindings),
            credential: () => {
              if (codexAuthority === undefined) {
                return Promise.reject(
                  new CodexCredentialUnavailableError('Codex gateway credential is unavailable'),
                );
              }
              return codexAuthority.resolve();
            },
            refreshAfterUnauthorized: (previousAccessToken) =>
              codexAuthority?.refreshAfterUnauthorized(previousAccessToken) ?? Promise.resolve(),
            onRequestEnd: options.onCodexRequestEnd ?? logCodexEgressRequestEnd,
          });
        }
      } catch (error) {
        peerBindings = previousBindings;
        codexAuthority = previousCodexAuthority;
        codexSpillKey = previousCodexSpillKey;
        codexSourceRevision = previousCodexSourceRevision;
        pendingCodexUpdate = previousPendingCodexUpdate;
        if (!revoking) accessToken = previousToken;
        if (spillMutated && credential !== undefined && !revoking) {
          try {
            if (previousToken === undefined) await spill.clear();
            else if (previousSpillKey !== undefined)
              await spill.unseal(previousSpillKey, previousToken);
            else
              throw new Error('Agent gateway has no prior spill key for rollback', {
                cause: error,
              });
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Agent gateway configuration and spill rollback failed',
              { cause: rollbackError },
            );
          }
        }
        try {
          if (previousCodexSnapshot === undefined) await codexSpill.clear();
          else if (previousCodexSpillKey !== undefined)
            await codexSpill.write(
              previousCodexSpillKey,
              previousCodexSourceRevision ?? '',
              previousCodexSnapshot,
            );
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Agent gateway configuration and Codex spill rollback failed',
            { cause: rollbackError },
          );
        }
        throw error;
      }
      if (nextCodexAuthority === undefined) {
        if (codexListener !== undefined) {
          await codexListener.close();
          codexListener = undefined;
        }
        await codexSpill.clear();
        pendingCodexUpdate = undefined;
      }
      peerBindings = nextBindings;
      accessToken = nextToken;
      spillKey = nextSpillKey;
      // Copy the mutable arrays crossing the process boundary. TLS strings are
      // immutable; the snapshot stays only in gateway memory and is never logged.
      configuration = {
        revision: next.revision,
        claude: {
          tls: { ...next.claude.tls },
          peerBindings: [...next.claude.peerBindings],
        },
        ...(next.codex === undefined
          ? {}
          : {
              codex: {
                credential: {
                  unsealKey: next.codex.credential.unsealKey,
                  sourceRevision: next.codex.credential.sourceRevision,
                },
              },
            }),
      };
      claudeRequired = credential !== undefined && credential.accessToken !== null;
      codexRequired = nextCodexCredential !== undefined && nextCodexCredential.authJson !== null;
    },
    status,
    readCodexCredentialUpdate: () => pendingCodexUpdate,
    // The Server's usage probe reads the account-global quota straight from the
    // ChatGPT backend. It gets a short-lived access token here rather than a copy
    // of the rotating refresh token, so this stays the only writer (ADR 0010).
    readCodexAccessToken: async () => {
      if (codexAuthority === undefined) return undefined;
      try {
        return await codexAuthority.resolve();
      } catch (error) {
        // The control answer is deliberately detail-free, so this is the only place
        // the actual reason survives. Without it a wrong banner has nothing behind
        // it to read.
        //
        // The detail is stripped from the socket because the sandbox is on the far
        // side of it; this log is the gateway's own stderr, on the trusted side, so
        // the reason is allowed here and nowhere else. One JSON line, as everything
        // else in this process logs (see `logCodexEgressRequestEnd`), which also
        // makes any text carried up from `fetch` inert rather than log-forging.
        console.warn(
          JSON.stringify({
            event: 'codex-access-token',
            outcome: 'failed',
            signInRejected:
              error instanceof CodexCredentialUnavailableError && error.signInRejected,
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        );
        throw error;
      }
    },
    ackCodexCredentialUpdate(sourceRevision, updatedRevision): void {
      if (
        pendingCodexUpdate?.sourceRevision === sourceRevision &&
        pendingCodexUpdate.updatedRevision === updatedRevision
      )
        pendingCodexUpdate = undefined;
    },
  });
  let health: Server | undefined;
  try {
    health = createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/healthz') {
        response.writeHead(404).end();
        return;
      }
      const current = status();
      const providerReady =
        (claudeRequired || codexRequired) &&
        (!claudeRequired || (current.credentialReady === true && current.listenerReady === true)) &&
        (!codexRequired ||
          (current.codexCredentialReady === true && current.codexListenerReady === true));
      response.writeHead(current.configured && providerReady ? 200 : 503, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify(current));
    });
    await listenHealth(health, options.healthPort, options.healthHost ?? '127.0.0.1');
    const address = health.address();
    const healthPort =
      typeof address === 'object' && address !== null ? address.port : options.healthPort;
    return {
      healthPort,
      status,
      async close(): Promise<void> {
        await Promise.all([
          closeHealth(health!),
          control.close(),
          listener?.close(),
          codexListener?.close(),
        ]);
      },
    };
  } catch (error) {
    await Promise.all([control.close(), listener?.close(), codexListener?.close()]);
    throw error;
  }
}

/**
 * Default sink for the gateway process, which logs via stdout/stderr.
 *
 * The record is already data-minimised by {@link ClaudeEgressRequestEnd};
 * emitting it as one JSON line keeps it greppable and makes any residual
 * caller-chosen text inert (JSON escaping), so a report cannot forge log
 * entries. Nothing is accumulated in memory — retention is whatever the
 * container log policy says.
 *
 * A completed request is ordinary traffic and goes to stdout; anything else is
 * a warning, so `docker logs … 2>&1 | grep '"outcome":"aborted"'` answers "did
 * the stream break on our side?" without wading through successful turns.
 */
export function logClaudeEgressRequestEnd(event: ClaudeEgressRequestEnd): void {
  const line = JSON.stringify({ event: 'claude-egress', ...event });
  if (event.outcome === 'completed') console.log(line);
  else console.warn(line);
}

export function logCodexEgressRequestEnd(event: CodexEgressRequestEnd): void {
  const line = JSON.stringify({ event: 'codex-egress', ...event });
  if (event.outcome === 'completed' || event.outcome === 'consumer-closed') console.log(line);
  else console.warn(line);
}

function listenHealth(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeHealth(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
