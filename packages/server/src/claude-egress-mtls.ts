import type { ServerOptions } from 'node:https';
import type { Socket } from 'node:net';
import { TLSSocket, type SecureContextOptions } from 'node:tls';

import {
  startClaudeEgressGateway,
  type ClaudeEgressGateway,
  type ClaudeEgressGatewayOptions,
} from './claude-egress-gateway.js';

export interface ClaudeEgressPeerBinding {
  projectId: string;
  /** SHA-256 fingerprint of the project's client certificate. */
  fingerprint256: string;
}

export interface ClaudeEgressPeerCertificate {
  authorized: boolean;
  fingerprint256?: string;
}

export type ClaudeEgressMtlsMaterial = Pick<SecureContextOptions, 'ca' | 'cert' | 'key'>;

export interface ClaudeEgressMtlsGatewayOptions extends Omit<
  ClaudeEgressGatewayOptions,
  'authenticatePeer' | 'tls'
> {
  tls: ClaudeEgressMtlsMaterial;
  /** Static peer bindings snapshot. Provide this OR {@link authenticatePeer}. */
  peerBindings?: readonly ClaudeEgressPeerBinding[] | undefined;
  /** A live peer authenticator (e.g. `ClaudeEgressPeerRegistry.authenticatePeer`)
   *  for bindings that change at runtime. Provide this OR {@link peerBindings}. */
  authenticatePeer?: ((socket: Socket) => string | undefined) | undefined;
}

export interface ClaudeEgressMtlsGateway extends Omit<ClaudeEgressGateway, 'reloadTls'> {
  reloadTls(material: ClaudeEgressMtlsMaterial): void;
}

/** Resolve a project only from a TLS-authenticated certificate fingerprint. */
export function resolveClaudeEgressPeerProject(
  peer: ClaudeEgressPeerCertificate,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  if (!peer.authorized || peer.fingerprint256 === undefined) return undefined;
  return bindings.get(normalizeFingerprint(peer.fingerprint256));
}

/**
 * Build the normalized fingerprint→project map from a binding list, rejecting an
 * empty project or a fingerprint bound more than once. Shared by the static
 * authenticator here and the mutable {@link ClaudeEgressPeerRegistry}, so both
 * validate and normalize identically. Does NOT enforce a non-empty result — a
 * live registry legitimately starts with no projects.
 */
export function buildClaudeEgressPeerBindings(
  bindings: readonly ClaudeEgressPeerBinding[],
): Map<string, string> {
  const projectsByFingerprint = new Map<string, string>();
  for (const binding of bindings) {
    if (binding.projectId.length === 0) throw new Error('Claude egress mTLS project is empty');
    const fingerprint = normalizeFingerprint(binding.fingerprint256);
    if (projectsByFingerprint.has(fingerprint)) {
      throw new Error('Claude egress mTLS fingerprint is bound more than once');
    }
    projectsByFingerprint.set(fingerprint, binding.projectId);
  }
  return projectsByFingerprint;
}

/** Resolve the authenticated project of a TLS peer against a fixed binding map. */
export function authenticateClaudeEgressPeer(
  socket: Socket,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  if (!(socket instanceof TLSSocket)) return undefined;
  const certificate = socket.getPeerCertificate();
  return resolveClaudeEgressPeerProject(
    {
      authorized: socket.authorized,
      ...(certificate.fingerprint256 === undefined
        ? {}
        : { fingerprint256: certificate.fingerprint256 }),
    },
    bindings,
  );
}

/** Build the socket authenticator consumed by the generic gateway handler. A
 *  STATIC snapshot — use {@link ClaudeEgressPeerRegistry} when bindings change at
 *  runtime (project provision/deprovision). */
export function createClaudeEgressMtlsAuthenticator(
  bindings: readonly ClaudeEgressPeerBinding[],
): (socket: Socket) => string | undefined {
  const projectsByFingerprint = buildClaudeEgressPeerBindings(bindings);
  if (projectsByFingerprint.size === 0) throw new Error('Claude egress mTLS requires a peer');
  return (socket): string | undefined =>
    authenticateClaudeEgressPeer(socket, projectsByFingerprint);
}

/**
 * Start the production-safe gateway shape: TLS 1.3 and a CA-verified client
 * certificate are mandatory, and the peer certificate selects project scope.
 */
export function startClaudeEgressMtlsGateway(
  options: ClaudeEgressMtlsGatewayOptions,
): Promise<ClaudeEgressMtlsGateway> {
  const { peerBindings, authenticatePeer, tls, ...rest } = options;
  if (peerBindings !== undefined && authenticatePeer !== undefined) {
    throw new Error('Claude egress mTLS gateway takes peerBindings OR authenticatePeer, not both');
  }
  const resolvePeer =
    authenticatePeer ??
    (peerBindings !== undefined ? createClaudeEgressMtlsAuthenticator(peerBindings) : undefined);
  if (resolvePeer === undefined) {
    throw new Error('Claude egress mTLS gateway requires peerBindings or authenticatePeer');
  }
  return startClaudeEgressGateway({
    ...rest,
    tls: claudeEgressMtlsServerOptions(tls),
    authenticatePeer: resolvePeer,
  }).then((gateway) => ({
    port: gateway.port,
    close: () => gateway.close(),
    reloadTls: (material): void => gateway.reloadTls(claudeEgressMtlsServerOptions(material)),
  }));
}

export function claudeEgressMtlsServerOptions(material: ClaudeEgressMtlsMaterial): ServerOptions {
  return {
    ...material,
    minVersion: 'TLSv1.3',
    requestCert: true,
    rejectUnauthorized: true,
    honorCipherOrder: true,
  };
}

/**
 * Canonicalize a certificate SHA-256 fingerprint to the registry key form:
 * colon-free, lowercase hex. Both the TLS peer fingerprint and any issuance-side
 * fingerprint must pass through here so the {@link createClaudeEgressMtlsAuthenticator}
 * map key matches the issued binding exactly.
 */
export function normalizeFingerprint(value: string): string {
  const normalized = value.replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('Claude egress mTLS fingerprint must be SHA-256');
  }
  return normalized;
}
