import { X509Certificate } from 'node:crypto';

import type { ClaudeEgressCaRecord, ClaudeEgressClientCertRecord } from '@verity/store';

import {
  createProjectEgressCa,
  gatewayMtlsMaterial,
  issueGatewayServerCertificate,
  issueProjectClientCertificate,
  sandboxEgressMaterial,
  type EgressCa,
  type GatewayMtlsMaterial,
  type PemCertificate,
  type ProjectClientCertificate,
  type SandboxEgressMaterial,
} from './claude-egress-ca.js';
import type { ClaudeEgressMtlsMaterial, ClaudeEgressPeerBinding } from './claude-egress-mtls.js';

/**
 * The persistence the identity service composes over. A narrow projection of the
 * `EventStore` methods (which encrypt the private-key columns at rest), so the
 * service can be unit-tested against a fake and the real store alike.
 */
export interface ClaudeEgressIdentityStore {
  getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined>;
  /** Update the singleton CA row in place (used to refresh only the gateway leaf
   *  while the CA itself is unchanged — client certs stay valid). */
  upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void>;
  /** Atomically install a freshly minted CA and drop every client cert in one
   *  transaction (rotation / first issuance). */
  replaceClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void>;
  getClaudeEgressClientCert(projectId: string): Promise<ClaudeEgressClientCertRecord | undefined>;
  upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void>;
  listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]>;
  deleteClaudeEgressClientCert(projectId: string): Promise<void>;
}

export interface ClaudeEgressIdentityService {
  /** The gateway's TLS material (CA + server cert/key) plus the current
   *  fingerprint→project peer bindings. Lazily mints/rotates the CA + gateway
   *  certificate; never mints client certs (peer bindings come from whatever is
   *  already issued). */
  gatewayMaterial(): Promise<GatewayMtlsMaterial>;
  /** The material projected into a project Sandbox: the public CA + that project's
   *  own client identity. Lazily issues/rotates the client certificate. */
  sandboxMaterial(projectId: string): Promise<SandboxEgressMaterial>;
  /** Drop a project's client certificate (deprovision / revocation). */
  revokeProject(projectId: string): Promise<void>;
}

export interface ClaudeEgressIdentityOptions {
  store: ClaudeEgressIdentityStore;
  /** DNS name the gateway listens as and the connector pins — also the gateway
   *  certificate's CN + SAN. */
  serverName: string;
  /** Transitional DNS SANs served by the same leaf while Sandboxes roll from the
   * legacy Server hostname to the stable standalone-gateway hostname. */
  additionalServerNames?: readonly string[];
  /** Re-issue a certificate once it is within this window of `notAfter`. Defaults
   *  to 7 days. */
  rotateBeforeExpiryMs?: number;
  /** CA / leaf lifetimes forwarded to the issuance functions (their own defaults
   *  apply when omitted). */
  caValidityDays?: number;
  leafValidityDays?: number;
  /** Injectable clock for deterministic rotation tests. */
  now?: () => Date;
  /** Invoked with the CURRENT peer-binding set whenever a client certificate is
   *  issued or revoked, so a live gateway peer registry stays in sync without a
   *  restart. A thrown/rejected callback is surfaced to the caller (the mutation
   *  already committed to the DB — the registry refresh is what failed). */
  onBindingsChanged?: (bindings: readonly ClaudeEgressPeerBinding[]) => void | Promise<void>;
  /** Activates a rotated gateway leaf while the existing CA remains authoritative.
   * CA rollover needs coordinated old/new client overlap and is intentionally not
   * live-reloaded through this callback. */
  onGatewayLeafChanged?: (material: ClaudeEgressMtlsMaterial) => void | Promise<void>;
}

const DEFAULT_ROTATE_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function notAfterOf(certPem: string): Date {
  return new Date(new X509Certificate(certPem).validTo);
}

/**
 * The Claude-egress identity lifecycle: it owns the Verity CA and issues, stores,
 * and rotates the gateway server certificate and per-project client certificates,
 * returning the exact {@link GatewayMtlsMaterial} / {@link SandboxEgressMaterial}
 * shapes the gateway and the sandbox projection consume.
 *
 * CA/leaf resolution is serialized inside the service. This keeps durable state,
 * live listener activation, and client issuance in one order even when concurrent
 * provisions resolve identity material at the same time.
 */
export function createClaudeEgressIdentityService(
  options: ClaudeEgressIdentityOptions,
): ClaudeEgressIdentityService {
  const { store, serverName } = options;
  const additionalServerNames = [...new Set(options.additionalServerNames ?? [])]
    .filter((name) => name !== serverName)
    .sort();
  const persistedServerNames = [serverName, ...additionalServerNames].join(',');
  const rotateBeforeExpiryMs = options.rotateBeforeExpiryMs ?? DEFAULT_ROTATE_BEFORE_EXPIRY_MS;
  const now = options.now ?? ((): Date => new Date());

  const isFresh = (expiresAt: Date): boolean =>
    expiresAt.getTime() - now().getTime() > rotateBeforeExpiryMs;

  const emitGatewayLeaf = async (ca: EgressCa, gateway: PemCertificate): Promise<void> => {
    await options.onGatewayLeafChanged?.({
      ca: ca.caCertPem,
      cert: gateway.certPem,
      key: gateway.keyPem,
    });
  };

  // Push the current binding set to the live registry (if wired) after a client
  // certificate is issued or revoked, so a newly provisioned project authenticates
  // immediately and a revoked one stops without a gateway restart.
  //
  // SERIALIZED through a tail queue: issuance is not internally locked (see the
  // factory docstring) and provision/deprovision run outside the per-project DB
  // lock, so concurrent emits could otherwise interleave their read + registry
  // swap and let a STALER snapshot win — dropping a just-issued binding or, worse,
  // resurrecting a revoked one. Chaining each emit after the previous makes the
  // "list current certs → replace registry" pair atomic relative to other emits,
  // so the final registry state always reflects every committed mutation.
  let emitTail: Promise<void> = Promise.resolve();
  async function emitBindings(): Promise<void> {
    const onBindingsChanged = options.onBindingsChanged;
    if (onBindingsChanged === undefined) return;
    const run = emitTail.then(async () => {
      const certs = await store.listClaudeEgressClientCerts();
      await onBindingsChanged(
        certs.map((cert) => ({ projectId: cert.projectId, fingerprint256: cert.fingerprint256 })),
      );
    });
    // Keep the chain alive even if this emit rejects (the next emit still runs),
    // while still surfacing the failure to THIS caller.
    emitTail = run.catch(() => undefined);
    return run;
  }

  async function loadOrIssueCaOnce(): Promise<{ ca: EgressCa; gateway: PemCertificate }> {
    const existing = await store.getClaudeEgressCa();
    if (existing !== undefined && isFresh(existing.caExpiresAt)) {
      const ca: EgressCa = { caCertPem: existing.caCertPem, caKeyPem: existing.caKeyPem };
      // The CA is still good; refresh only the gateway leaf when it is near expiry
      // or the pinned server name changed. Client certs still chain to this CA.
      if (
        existing.gatewayServerName === persistedServerNames &&
        isFresh(existing.gatewayExpiresAt)
      ) {
        const gateway = { certPem: existing.gatewayCertPem, keyPem: existing.gatewayKeyPem };
        return {
          ca,
          gateway,
        };
      }
      const gateway = await issueGatewayServerCertificate(ca, {
        serverName,
        additionalServerNames,
        ...(options.leafValidityDays !== undefined
          ? { validityDays: options.leafValidityDays }
          : {}),
      });
      // Activate before persisting. If live reload fails, the durable record stays
      // stale and the next resolution retries instead of silently considering the
      // listener reconciled. A crash after activation is safe: the old persisted
      // leaf remains valid and is restored on restart.
      await emitGatewayLeaf(ca, gateway);
      try {
        await store.upsertClaudeEgressCa({
          ...existing,
          gatewayServerName: persistedServerNames,
          gatewayCertPem: gateway.certPem,
          gatewayKeyPem: gateway.keyPem,
          gatewayExpiresAt: notAfterOf(gateway.certPem),
        });
      } catch (persistError) {
        try {
          await emitGatewayLeaf(ca, {
            certPem: existing.gatewayCertPem,
            keyPem: existing.gatewayKeyPem,
          });
        } catch (rollbackError) {
          throw new AggregateError(
            [persistError, rollbackError],
            'gateway leaf persistence and activation rollback failed',
            { cause: rollbackError },
          );
        }
        throw persistError;
      }
      return { ca, gateway };
    }

    // Mint a fresh CA (missing or near expiry) and a matching gateway leaf.
    const minted = await createProjectEgressCa(
      options.caValidityDays !== undefined ? { validityDays: options.caValidityDays } : {},
    );
    const gateway = await issueGatewayServerCertificate(minted, {
      serverName,
      additionalServerNames,
      ...(options.leafValidityDays !== undefined ? { validityDays: options.leafValidityDays } : {}),
    });
    // Install the fresh CA and drop every old-CA client cert atomically: those
    // certs no longer chain to the new CA, so serving them as peer bindings would
    // silently break the affected projects' mTLS. A crash mid-rotation leaves
    // either the old world or the new one, never a fresh CA with orphaned certs.
    // Each project then re-issues lazily against the new CA on its next request.
    // Activate the new trust root and leaf before making them durable, matching
    // same-CA leaf rotation above. If activation fails, the old durable world is
    // retained and the next resolution retries instead of stranding the live
    // gateway on certificates its store no longer knows.
    await emitGatewayLeaf(minted, gateway);
    try {
      await store.replaceClaudeEgressCa({
        caCertPem: minted.caCertPem,
        caKeyPem: minted.caKeyPem,
        gatewayServerName: persistedServerNames,
        gatewayCertPem: gateway.certPem,
        gatewayKeyPem: gateway.keyPem,
        caExpiresAt: notAfterOf(minted.caCertPem),
        gatewayExpiresAt: notAfterOf(gateway.certPem),
      });
    } catch (persistError) {
      if (existing !== undefined) {
        try {
          await emitGatewayLeaf(
            { caCertPem: existing.caCertPem, caKeyPem: existing.caKeyPem },
            { certPem: existing.gatewayCertPem, keyPem: existing.gatewayKeyPem },
          );
        } catch (rollbackError) {
          throw new AggregateError(
            [persistError, rollbackError],
            'CA persistence and activation rollback failed',
            { cause: rollbackError },
          );
        }
      }
      throw persistError;
    }
    return { ca: minted, gateway };
  }

  let identityTail: Promise<void> = Promise.resolve();
  function loadOrIssueCa(): Promise<{ ca: EgressCa; gateway: PemCertificate }> {
    const run = identityTail.then(() => loadOrIssueCaOnce());
    identityTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // Certificate lookup + issuance and revocation must be one operation per
  // project. Without this queue, two concurrent provisions can both observe a
  // missing row and mint different leaves, or a revoke can delete a row just
  // before an in-flight provision writes it back and silently resurrects access.
  const projectTails = new Map<string, Promise<void>>();
  function withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = projectTails.get(projectId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    projectTails.set(projectId, settled);
    void settled.finally(() => {
      if (projectTails.get(projectId) === settled) projectTails.delete(projectId);
    });
    return run;
  }

  return {
    async gatewayMaterial(): Promise<GatewayMtlsMaterial> {
      const { ca, gateway } = await loadOrIssueCa();
      const clients = await store.listClaudeEgressClientCerts();
      return gatewayMtlsMaterial(ca, gateway, clients);
    },

    async sandboxMaterial(projectId): Promise<SandboxEgressMaterial> {
      return withProjectLock(projectId, async () => {
        // Resolve the CA first: a CA rotation here clears stale client rows, so the
        // lookup below then re-issues against the fresh CA.
        const { ca } = await loadOrIssueCa();
        const existing = await store.getClaudeEgressClientCert(projectId);
        let client: ProjectClientCertificate;
        if (existing !== undefined && isFresh(existing.expiresAt)) {
          client = {
            projectId,
            certPem: existing.certPem,
            keyPem: existing.keyPem,
            fingerprint256: existing.fingerprint256,
          };
        } else {
          const issued = await issueProjectClientCertificate(ca, {
            projectId,
            ...(options.leafValidityDays !== undefined
              ? { validityDays: options.leafValidityDays }
              : {}),
          });
          await store.upsertClaudeEgressClientCert({
            projectId,
            certPem: issued.certPem,
            keyPem: issued.keyPem,
            fingerprint256: issued.fingerprint256,
            expiresAt: notAfterOf(issued.certPem),
          });
          client = issued;
          // A new (or rotated) fingerprint was persisted — refresh the live registry.
          await emitBindings();
        }
        return sandboxEgressMaterial(ca, client);
      });
    },

    async revokeProject(projectId): Promise<void> {
      await withProjectLock(projectId, async () => {
        await store.deleteClaudeEgressClientCert(projectId);
        await emitBindings();
      });
    },
  };
}
