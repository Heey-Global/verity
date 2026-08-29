import { chmod } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';

import type { ClaudeEgressMtlsMaterial, ClaudeEgressPeerBinding } from './claude-egress-mtls.js';
import {
  CodexCredentialUnavailableError,
  CodexSignInUnusableError,
} from './codex-sign-in-error.js';
import {
  closeUnixServer,
  ControlProtocolError,
  DEFAULT_CONTROL_TIMEOUT_MS,
  exchangeControlFrame,
  isRecord,
  listenUnix,
  prepareControlSocketPath,
  readControlFrame,
  writeControlFrame,
} from './control-socket.js';

/** Diagnostic prefix for transport-level failures on this channel. */
const CONTROL_LABEL = 'Agent gateway control';

export interface AgentGatewayConfiguration {
  revision: string;
  claude: {
    tls: Required<ClaudeEgressMtlsMaterial>;
    peerBindings: readonly ClaudeEgressPeerBinding[];
    credential?: {
      /** Ephemeral unseal key delivered only over the private control socket. */
      unsealKey: string;
      /** Omitted when recovering the encrypted local spill after restart. */
      accessToken?: string | null;
    };
  };
  /** Dormant until the Codex C3 cutover projects this section. Codex reuses the
   * gateway mTLS identity set above but owns an independent rotating login. */
  codex?: {
    credential: {
      unsealKey: string;
      /** Digest of the Server-owned source login. Prevents a late refresh from
       * overwriting a newer login or logout. */
      sourceRevision: string;
      /** Omitted to recover spill; null revokes; string installs a fresh login. */
      authJson?: string | null;
    };
  };
}

export interface AgentGatewayStatus {
  ready: true;
  configured: boolean;
  revision?: string;
  claudePeerCount: number;
  credentialReady?: boolean;
  listenerReady?: boolean;
  claudePort?: number;
  codexCredentialReady?: boolean;
  codexListenerReady?: boolean;
  codexPort?: number;
}

type ControlRequest =
  | { type: 'configure'; configuration: AgentGatewayConfiguration }
  | { type: 'status' }
  | { type: 'read-codex-credential-update' }
  | { type: 'ack-codex-credential-update'; sourceRevision: string; updatedRevision: string }
  | { type: 'read-codex-access-token' };
export interface CodexCredentialUpdate {
  sourceRevision: string;
  updatedRevision: string;
  authJson: string;
}
/**
 * A short-lived Codex access token plus its account scope, handed back to the
 * Server so a non-agent consumer — today only the account-global usage probe —
 * can call the ChatGPT backend without holding the rotating refresh token. The
 * gateway remains the single refresh authority (ADR 0010): this frame reads what
 * the authority already holds, it never mints a login of its own.
 */
export interface CodexAccessToken {
  accessToken: string;
  accountId: string;
}
type ControlResponse =
  | { ok: true; status: AgentGatewayStatus }
  | { ok: true; codexCredentialUpdate: CodexCredentialUpdate | null }
  | { ok: true; codexAccessToken: CodexAccessToken | null }
  // `signInRejected` is the one thing a failure on this channel is allowed to say
  // about itself, and it carries no detail — only which of two remedies applies.
  // Without it every `ok: false` looks alike, and "the gateway declined the stored
  // Codex login" (fixed by signing in again) is indistinguishable from an unknown
  // frame, a malformed request, or an internal error (fixed by neither). Absent on
  // every other failure and on every older gateway, so a missing flag reads as
  // "not known to be a sign-in problem" rather than as a refusal. Typed `boolean`
  // for what may be READ — a peer is free to say `false` where this one stays
  // silent, and both mean the same thing — while this gateway only ever writes
  // `true`. Every reader tests `=== true`.
  | { ok: false; error: string; signInRejected?: boolean };
type ParsedControlRequest = { request: ControlRequest } | { error: unknown };

export interface AgentGatewayControlServer {
  close(): Promise<void>;
}

/** The gateway-side handlers backing each control frame. */
interface ControlHandlers {
  configure: (configuration: AgentGatewayConfiguration) => void | Promise<void>;
  status: () => AgentGatewayStatus;
  readCodexCredentialUpdate?: () => CodexCredentialUpdate | undefined;
  ackCodexCredentialUpdate?: (sourceRevision: string, updatedRevision: string) => void;
  /** Rejects/throws when no Codex login is installed or a refresh fails; the
   *  caller sees only the structural error, never the failure detail. */
  readCodexAccessToken?: () => Promise<CodexAccessToken | undefined> | CodexAccessToken | undefined;
}

export async function startAgentGatewayControlServer(
  options: ControlHandlers & {
    socketPath: string;
    requestTimeoutMs?: number;
  },
): Promise<AgentGatewayControlServer> {
  await prepareControlSocketPath({
    socketPath: options.socketPath,
    label: CONTROL_LABEL,
    probe: { type: 'status' } satisfies ControlRequest,
  });
  let controlTail: Promise<void> = Promise.resolve();
  const server = createServer((socket) => {
    // Start reading immediately. A later connection may time out while an older
    // configuration is still applying; retaining its settled result prevents an
    // already-closed socket from blocking the serialized queue forever.
    const parsed = readControlRequest(
      socket,
      options.requestTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
    );
    // Apply accepted connections in order so a slow older configuration cannot
    // commit after a newer snapshot and silently roll the gateway backwards.
    controlTail = controlTail.then(() => handleControlSocket(socket, options, parsed));
  });
  await listenUnix(server, options.socketPath);
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await closeUnixServer(server).catch(() => undefined);
    throw error;
  }
  return {
    async close(): Promise<void> {
      // Node removes a pathname-backed Unix socket as part of server.close().
      // Do not unlink afterward: a replacement process may have bound the path
      // between close completion and a second cleanup operation.
      await closeUnixServer(server);
    },
  };
}

export async function configureAgentGateway(
  socketPath: string,
  configuration: AgentGatewayConfiguration,
): Promise<AgentGatewayStatus> {
  const response = await exchange(socketPath, { type: 'configure', configuration });
  if (!response.ok) throw new Error(`Agent gateway configuration failed: ${response.error}`);
  if (!('status' in response)) throw new Error('Agent gateway returned an invalid response');
  return response.status;
}

export async function readAgentGatewayStatus(socketPath: string): Promise<AgentGatewayStatus> {
  const response = await exchange(socketPath, { type: 'status' });
  if (!response.ok) throw new Error(`Agent gateway status failed: ${response.error}`);
  if (!('status' in response)) throw new Error('Agent gateway returned an invalid response');
  return response.status;
}

export async function readCodexCredentialUpdate(
  socketPath: string,
): Promise<CodexCredentialUpdate | undefined> {
  const response = await exchange(socketPath, { type: 'read-codex-credential-update' });
  if (!response.ok) throw new Error(`Agent gateway credential read failed: ${response.error}`);
  if (!('codexCredentialUpdate' in response))
    throw new Error('Agent gateway returned an invalid response');
  return response.codexCredentialUpdate ?? undefined;
}

/**
 * The gateway answered and said the Codex SIGN-IN is what failed: the refresh for
 * the login it holds was rejected, or the authority could not produce a token.
 *
 * Raised only for a response that carries `signInRejected`, never for an
 * `ok: false` in general — an unknown frame, a malformed request or an internal
 * gateway error are all fixed by something other than a re-login, and a class
 * that claimed them would put a "Sign in to Codex" button on all of them.
 *
 * A subclass of {@link CodexSignInUnusableError} so the usage probe recognises it
 * with no adapter in between: `readCodexAccessToken` can be passed straight to
 * `createCodexUsageService` as a credential provider, and there is no translation
 * layer to keep in sync.
 */
export class CodexAccessTokenRejectedError extends CodexSignInUnusableError {
  constructor(detail: string) {
    super(`Agent gateway access token read failed: ${detail}`);
    this.name = 'CodexAccessTokenRejectedError';
  }
}

/**
 * Read the gateway's current Codex access token. `undefined` when no Codex login
 * is installed; throws {@link CodexAccessTokenRejectedError} when the gateway
 * says the sign-in itself failed, and a plain error for every other refusal or
 * for a control channel that did not answer, so callers must treat this as
 * best-effort.
 */
export async function readCodexAccessToken(
  socketPath: string,
): Promise<CodexAccessToken | undefined> {
  const response = await exchange(socketPath, { type: 'read-codex-access-token' });
  if (!response.ok) {
    if (response.signInRejected === true) throw new CodexAccessTokenRejectedError(response.error);
    throw new Error(`Agent gateway access token read failed: ${response.error}`);
  }
  if (!('codexAccessToken' in response))
    throw new Error('Agent gateway returned an invalid response');
  return response.codexAccessToken ?? undefined;
}

export async function ackCodexCredentialUpdate(
  socketPath: string,
  update: Pick<CodexCredentialUpdate, 'sourceRevision' | 'updatedRevision'>,
): Promise<void> {
  const response = await exchange(socketPath, { type: 'ack-codex-credential-update', ...update });
  if (!response.ok) throw new Error(`Agent gateway credential ack failed: ${response.error}`);
}

async function handleControlSocket(
  socket: Socket,
  options: ControlHandlers,
  parsed: Promise<ParsedControlRequest>,
): Promise<void> {
  try {
    const result = await parsed;
    if ('error' in result) throw result.error;
    const request = result.request;
    if (request.type === 'configure') await options.configure(request.configuration);
    if (request.type === 'read-codex-credential-update') {
      writeControlFrame(socket, {
        ok: true,
        codexCredentialUpdate: options.readCodexCredentialUpdate?.() ?? null,
      });
      return;
    }
    if (request.type === 'read-codex-access-token') {
      // Caught HERE rather than in the outer handler so the answer can say that
      // the SIGN-IN is what failed. Only this call can fail that way; everything
      // else reaching the outer catch is the frame or the gateway.
      let token: CodexAccessToken | undefined;
      try {
        token = await options.readCodexAccessToken?.();
      } catch (error) {
        // The reader decides. "Something threw" is not the same claim as "signing
        // in again fixes this" — a token endpoint that is unreachable, or a bug in
        // the reader, throws here too, and neither survives a new sign-in.
        //
        // Still no detail either way: the failure reason can name the account or
        // quote the OAuth response, and this channel also carries TLS keys.
        writeControlFrame(socket, {
          ok: false,
          error: 'codex access token unavailable',
          ...(error instanceof CodexCredentialUnavailableError && error.signInRejected
            ? { signInRejected: true as const }
            : {}),
        });
        return;
      }
      writeControlFrame(socket, { ok: true, codexAccessToken: token ?? null });
      return;
    }
    if (request.type === 'ack-codex-credential-update') {
      options.ackCodexCredentialUpdate?.(request.sourceRevision, request.updatedRevision);
    }
    writeControlFrame(socket, { ok: true, status: options.status() });
  } catch (error) {
    // Never reflect parser input or configuration contents: TLS keys cross this
    // channel, so diagnostics must stay structural and credential-free.
    const message =
      error instanceof ControlProtocolError ? error.message : 'control request failed';
    writeControlFrame(socket, { ok: false, error: message });
  }
}

async function readControlRequest(
  socket: Socket,
  timeoutMs: number,
): Promise<ParsedControlRequest> {
  socket.setTimeout(timeoutMs, () => {
    socket.destroy();
  });
  try {
    return { request: parseRequest(await readControlFrame(socket)) };
  } catch (error) {
    return { error };
  }
}

function parseRequest(value: unknown): ControlRequest {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new ControlProtocolError('invalid control request');
  }
  if (value.type === 'status') return { type: 'status' };
  if (value.type === 'read-codex-credential-update') return { type: value.type };
  if (value.type === 'read-codex-access-token') return { type: value.type };
  if (
    value.type === 'ack-codex-credential-update' &&
    typeof value.sourceRevision === 'string' &&
    typeof value.updatedRevision === 'string'
  ) {
    return {
      type: value.type,
      sourceRevision: value.sourceRevision,
      updatedRevision: value.updatedRevision,
    };
  }
  if (value.type !== 'configure' || !isConfiguration(value.configuration)) {
    throw new ControlProtocolError('invalid gateway configuration');
  }
  return { type: 'configure', configuration: value.configuration };
}

function isConfiguration(value: unknown): value is AgentGatewayConfiguration {
  if (!isRecord(value) || typeof value.revision !== 'string' || value.revision.length === 0) {
    return false;
  }
  const claude = value.claude;
  if (!isRecord(claude) || !isRecord(claude.tls) || !Array.isArray(claude.peerBindings)) {
    return false;
  }
  if (
    typeof claude.tls.ca !== 'string' ||
    typeof claude.tls.cert !== 'string' ||
    typeof claude.tls.key !== 'string' ||
    claude.tls.ca.length === 0 ||
    claude.tls.cert.length === 0 ||
    claude.tls.key.length === 0
  ) {
    return false;
  }
  if (claude.credential !== undefined) {
    if (
      !isRecord(claude.credential) ||
      typeof claude.credential.unsealKey !== 'string' ||
      !/^[a-f0-9]{64}$/iu.test(claude.credential.unsealKey)
    ) {
      return false;
    }
    if (
      claude.credential.accessToken !== undefined &&
      claude.credential.accessToken !== null &&
      (typeof claude.credential.accessToken !== 'string' ||
        claude.credential.accessToken.length === 0 ||
        /[\r\n]/u.test(claude.credential.accessToken))
    ) {
      return false;
    }
  }
  if (value.codex !== undefined) {
    if (!isRecord(value.codex) || !isRecord(value.codex.credential)) return false;
    const credential = value.codex.credential;
    if (
      typeof credential.unsealKey !== 'string' ||
      !/^[a-f0-9]{64}$/iu.test(credential.unsealKey) ||
      typeof credential.sourceRevision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(credential.sourceRevision)
    ) {
      return false;
    }
    if (
      credential.authJson !== undefined &&
      credential.authJson !== null &&
      (typeof credential.authJson !== 'string' || credential.authJson.trim().length === 0)
    ) {
      return false;
    }
  }
  return claude.peerBindings.every(
    (binding) =>
      isRecord(binding) &&
      typeof binding.projectId === 'string' &&
      binding.projectId.length > 0 &&
      typeof binding.fingerprint256 === 'string' &&
      /^[a-f0-9:]{64,95}$/iu.test(binding.fingerprint256),
  );
}

async function exchange(socketPath: string, request: ControlRequest): Promise<ControlResponse> {
  const value = await exchangeControlFrame({ socketPath, request, label: CONTROL_LABEL });
  if (!isControlResponse(value)) throw new Error('Agent gateway returned an invalid response');
  return value;
}

function isControlResponse(value: unknown): value is ControlResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  // `signInRejected` must be a boolean or absent — this gateway only ever writes
  // `true`, but an explicit `false` is the same claim as leaving it out and is not
  // worth discarding a perfectly good error string over. Anything else — a
  // string, a 0 — is a gateway this one does not understand, and the safe reading
  // of "I could not parse your claim that the sign-in was refused" is not to claim
  // it was. Only `=== true` is a refusal at the call sites below.
  if (value.ok === false)
    return (
      typeof value.error === 'string' &&
      (value.signInRejected === undefined || typeof value.signInRejected === 'boolean')
    );
  if ('codexCredentialUpdate' in value) {
    const update = value.codexCredentialUpdate;
    return (
      update === null ||
      (isRecord(update) &&
        typeof update.sourceRevision === 'string' &&
        typeof update.updatedRevision === 'string' &&
        typeof update.authJson === 'string')
    );
  }
  if ('codexAccessToken' in value) {
    const token = value.codexAccessToken;
    return (
      token === null ||
      (isRecord(token) &&
        typeof token.accessToken === 'string' &&
        token.accessToken.length > 0 &&
        typeof token.accountId === 'string' &&
        token.accountId.length > 0)
    );
  }
  const status = value.status;
  return (
    isRecord(status) &&
    status.ready === true &&
    typeof status.configured === 'boolean' &&
    typeof status.claudePeerCount === 'number' &&
    (status.credentialReady === undefined || typeof status.credentialReady === 'boolean') &&
    (status.listenerReady === undefined || typeof status.listenerReady === 'boolean') &&
    (status.claudePort === undefined || typeof status.claudePort === 'number') &&
    (status.codexCredentialReady === undefined ||
      typeof status.codexCredentialReady === 'boolean') &&
    (status.codexListenerReady === undefined || typeof status.codexListenerReady === 'boolean') &&
    (status.codexPort === undefined || typeof status.codexPort === 'number') &&
    (status.revision === undefined || typeof status.revision === 'string')
  );
}
