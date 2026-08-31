import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  normalizeFingerprint,
  type ClaudeEgressMtlsMaterial,
  type ClaudeEgressPeerBinding,
} from './claude-egress-mtls.js';

const execFileAsync = promisify(execFile);

/** Reject subject/SAN values that could break `-subj`/SAN parsing or inject an
 *  extra RDN. Project ids and server names both flow into an X.509 subject, so
 *  only a conservative DNS/id charset is accepted. The length cap matches the
 *  `SAFE_ID` used across the runner transport so any id the system accepts can
 *  also be issued a certificate. */
const SAFE_SUBJECT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Free-text subject fields (the CA common name) may contain spaces, but must
 *  never contain the `/` RDN separator or control characters that would let a
 *  caller inject an extra relative distinguished name into `-subj`. */
const SAFE_SUBJECT_TEXT = /^[^/\\\r\n\0]{1,64}$/u;

const DEFAULT_CA_VALIDITY_DAYS = 3650;
const DEFAULT_LEAF_VALIDITY_DAYS = 90;
const KEY_SPEC = 'rsa:2048';

/**
 * A Verity-owned Claude-egress CA. `caCertPem` is the public trust anchor that
 * may be projected into a Sandbox; `caKeyPem` is the signing key and MUST stay
 * server-side — ADR 0006 D10 keeps the private CA key outside project Sandboxes.
 */
export interface EgressCa {
  readonly caCertPem: string;
  readonly caKeyPem: string;
}

/** A signed leaf certificate with its private key, both PEM-encoded. */
export interface PemCertificate {
  readonly certPem: string;
  readonly keyPem: string;
}

/** A per-project client certificate plus the SHA-256 fingerprint the gateway
 *  uses to resolve the peer's project (see {@link ClaudeEgressPeerBinding}). The
 *  fingerprint is the canonical registry form: colon-free lowercase hex. */
export interface ProjectClientCertificate extends PemCertificate {
  readonly projectId: string;
  readonly fingerprint256: string;
}

/** Everything the gateway needs: its own TLS material plus the fingerprint→
 *  project bindings. Contains the CA public cert and the server key, never a
 *  client key. */
export interface GatewayMtlsMaterial {
  readonly tls: ClaudeEgressMtlsMaterial;
  readonly peerBindings: readonly ClaudeEgressPeerBinding[];
}

/**
 * The only cert material that crosses into a project Sandbox: the public CA (to
 * pin the gateway) and this project's own client identity. It deliberately has
 * no field for the CA private key, so the server↔Sandbox boundary is expressed
 * in the type itself.
 */
export interface SandboxEgressMaterial {
  readonly projectId: string;
  readonly caCertPem: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'verity-egress-ca-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Bound every openssl invocation so a wedged subprocess can never leave an
 *  issuance promise pending forever. */
const OPENSSL_TIMEOUT_MS = 20_000;

async function openssl(dir: string, args: readonly string[]): Promise<void> {
  await execFileAsync('openssl', [...args], {
    cwd: dir,
    timeout: OPENSSL_TIMEOUT_MS,
    windowsHide: true,
  });
}

function assertSafeSubjectValue(value: string, label: string): void {
  if (!SAFE_SUBJECT_VALUE.test(value)) {
    throw new Error(`Claude egress ${label} must match ${SAFE_SUBJECT_VALUE.source}`);
  }
}

function assertSafeSubjectText(value: string, label: string): void {
  if (!SAFE_SUBJECT_TEXT.test(value)) {
    throw new Error(`Claude egress ${label} must not contain '/' or control characters`);
  }
}

function validityDays(requested: number | undefined, fallback: number): string {
  const days = requested ?? fallback;
  if (!Number.isInteger(days) || days <= 0) {
    throw new Error('Claude egress certificate validity must be a positive integer of days');
  }
  return String(days);
}

/**
 * Generate a fresh Verity-owned Claude-egress CA. The returned private key is a
 * server-held secret; only {@link EgressCa.caCertPem} is safe to project.
 */
export async function createProjectEgressCa(
  options: { commonName?: string; validityDays?: number } = {},
): Promise<EgressCa> {
  const commonName = options.commonName ?? 'Verity Claude Egress CA';
  assertSafeSubjectText(commonName, 'CA common name');
  const days = validityDays(options.validityDays, DEFAULT_CA_VALIDITY_DAYS);
  return await withTempDir(async (dir) => {
    await openssl(dir, [
      'req',
      '-x509',
      '-newkey',
      KEY_SPEC,
      '-nodes',
      '-days',
      days,
      '-subj',
      `/CN=${commonName}`,
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
    ]);
    const [caKeyPem, caCertPem] = await Promise.all([
      readFile(join(dir, 'ca.key'), 'utf8'),
      readFile(join(dir, 'ca.crt'), 'utf8'),
    ]);
    return { caCertPem, caKeyPem };
  });
}

interface LeafRequest {
  readonly commonName: string;
  readonly extensions: string;
  readonly days: string;
}

async function issueLeaf(ca: EgressCa, request: LeafRequest): Promise<PemCertificate> {
  return await withTempDir(async (dir) => {
    await Promise.all([
      writeFile(join(dir, 'ca.crt'), ca.caCertPem),
      // The CA signing key touches disk only inside this 0700 temp dir and only
      // for the openssl signing call; keep the file owner-only as defense in depth.
      writeFile(join(dir, 'ca.key'), ca.caKeyPem, { mode: 0o600 }),
      writeFile(join(dir, 'leaf.ext'), request.extensions),
    ]);
    await openssl(dir, [
      'req',
      '-newkey',
      KEY_SPEC,
      '-nodes',
      '-subj',
      `/CN=${request.commonName}`,
      '-keyout',
      'leaf.key',
      '-out',
      'leaf.csr',
    ]);
    await openssl(dir, [
      'x509',
      '-req',
      '-days',
      request.days,
      '-in',
      'leaf.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-extfile',
      'leaf.ext',
      '-out',
      'leaf.crt',
    ]);
    const [keyPem, certPem] = await Promise.all([
      readFile(join(dir, 'leaf.key'), 'utf8'),
      readFile(join(dir, 'leaf.crt'), 'utf8'),
    ]);
    return { certPem, keyPem };
  });
}

/**
 * Issue the gateway's server certificate, signed by {@link ca}. The name is
 * used as both CN and a DNS SAN so the connector can pin it via
 * `VERITY_CLAUDE_EGRESS_SERVERNAME`.
 */
export async function issueGatewayServerCertificate(
  ca: EgressCa,
  options: {
    serverName: string;
    additionalServerNames?: readonly string[];
    validityDays?: number;
  },
): Promise<PemCertificate> {
  assertSafeSubjectValue(options.serverName, 'server name');
  const serverNames = [options.serverName, ...(options.additionalServerNames ?? [])];
  for (const serverName of serverNames) assertSafeSubjectValue(serverName, 'server name');
  const uniqueServerNames = [...new Set(serverNames)];
  return await issueLeaf(ca, {
    commonName: options.serverName,
    days: validityDays(options.validityDays, DEFAULT_LEAF_VALIDITY_DAYS),
    extensions: [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${uniqueServerNames.map((name) => `DNS:${name}`).join(',')}`,
      '',
    ].join('\n'),
  });
}

/**
 * Issue a per-project client certificate signed by {@link ca} and compute the
 * SHA-256 fingerprint the mTLS gateway resolves to {@link projectId}. The
 * fingerprint is the DER SHA-256 canonicalized to the gateway registry key form
 * (colon-free lowercase), so a stored binding compares equal to what the mTLS
 * authenticator derives from `socket.getPeerCertificate().fingerprint256`.
 */
export async function issueProjectClientCertificate(
  ca: EgressCa,
  options: { projectId: string; validityDays?: number },
): Promise<ProjectClientCertificate> {
  assertSafeSubjectValue(options.projectId, 'project id');
  const leaf = await issueLeaf(ca, {
    commonName: options.projectId,
    days: validityDays(options.validityDays, DEFAULT_LEAF_VALIDITY_DAYS),
    extensions: [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=clientAuth',
      '',
    ].join('\n'),
  });
  // Canonicalize to the gateway registry key form (colon-free lowercase) at the
  // source, so a stored/rotated fingerprint compares equal to what the mTLS
  // authenticator derives from `socket.getPeerCertificate().fingerprint256`.
  const fingerprint256 = normalizeFingerprint(new X509Certificate(leaf.certPem).fingerprint256);
  return { projectId: options.projectId, fingerprint256, ...leaf };
}

/**
 * Assemble the gateway's mTLS material: the CA public cert to verify clients,
 * the gateway server cert/key, and the fingerprint→project bindings. No client
 * private key is included.
 */
export function gatewayMtlsMaterial(
  ca: EgressCa,
  server: PemCertificate,
  clients: readonly ProjectClientCertificate[],
): GatewayMtlsMaterial {
  return {
    tls: { ca: ca.caCertPem, cert: server.certPem, key: server.keyPem },
    peerBindings: clients.map((client) => ({
      projectId: client.projectId,
      fingerprint256: client.fingerprint256,
    })),
  };
}

/**
 * Project only the public CA and a single project's own client identity into a
 * Sandbox. The CA private key is never part of the result — the boundary from
 * ADR 0006 D10 is enforced by construction.
 */
export function sandboxEgressMaterial(
  ca: EgressCa,
  client: ProjectClientCertificate,
): SandboxEgressMaterial {
  return {
    projectId: client.projectId,
    caCertPem: ca.caCertPem,
    clientCertPem: client.certPem,
    clientKeyPem: client.keyPem,
  };
}
