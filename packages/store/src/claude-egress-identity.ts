import { sql, type Kysely } from 'kysely';
import type { SecretCipher } from './crypto.js';
import type { Database } from './schema.js';

/** The Verity-owned Claude-egress CA + gateway server identity (singleton). The
 *  `caKeyPem`/`gatewayKeyPem` are decrypted on read; they are SECRETS and never
 *  leave the server. */
export interface ClaudeEgressCaRecord {
  caCertPem: string;
  caKeyPem: string;
  gatewayServerName: string;
  gatewayCertPem: string;
  gatewayKeyPem: string;
  caExpiresAt: Date;
  gatewayExpiresAt: Date;
}

/** A per-project Claude-egress client certificate. `keyPem` is decrypted on read
 *  (a SECRET); the cert + fingerprint are non-secret. */
export interface ClaudeEgressClientCertRecord {
  projectId: string;
  /** The person whose sandbox presents this certificate (ADR 0023 §4). */
  userId: string;
  certPem: string;
  keyPem: string;
  fingerprint256: string;
  expiresAt: Date;
}

export class ClaudeEgressIdentityStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly cipher: SecretCipher,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Read the singleton Claude-egress CA + gateway identity, decrypting the CA +
   *  gateway private keys. Returns undefined before the first issuance. */
  async getClaudeEgressCa(): Promise<ClaudeEgressCaRecord | undefined> {
    const row = await this.db
      .selectFrom('claude_egress_ca')
      .selectAll()
      .where('id', '=', 'global')
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      caCertPem: row.ca_cert_pem,
      caKeyPem: this.cipher.decrypt(row.ca_key_pem),
      gatewayServerName: row.gateway_server_name,
      gatewayCertPem: row.gateway_cert_pem,
      gatewayKeyPem: this.cipher.decrypt(row.gateway_key_pem),
      caExpiresAt: new Date(row.ca_expires_at),
      gatewayExpiresAt: new Date(row.gateway_expires_at),
    };
  }

  /** Insert or replace the singleton CA + gateway identity, encrypting both
   *  private keys at rest. A re-issue (rotation) overwrites the single row. */
  async upsertClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    const values = this.claudeEgressCaValues(record);
    await this.db
      .insertInto('claude_egress_ca')
      .values({ id: 'global', ...values })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_at: sql`now()` }))
      .execute();
  }

  /**
   * Atomically install a freshly minted CA (first issuance or rotation) AND wipe
   * every per-project client cert in ONE transaction. The old client certs were
   * signed by the superseded CA and no longer chain to it, so they must never
   * survive a CA rotation as stale, un-authenticatable peer bindings. Doing the
   * CA write and the wipe together makes a mid-rotation crash leave either the old
   * world or the new one, never a fresh CA alongside orphaned old-CA client certs.
   */
  async replaceClaudeEgressCa(record: ClaudeEgressCaRecord): Promise<void> {
    const values = this.claudeEgressCaValues(record);
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('claude_egress_ca')
        .values({ id: 'global', ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...values, updated_at: sql`now()` }))
        .execute();
      await tx.deleteFrom('claude_egress_client_certs').execute();
    });
  }

  /** Encrypt the CA and gateway private keys before persisting them. */
  private claudeEgressCaValues(record: ClaudeEgressCaRecord): {
    ca_cert_pem: string;
    ca_key_pem: string;
    gateway_server_name: string;
    gateway_cert_pem: string;
    gateway_key_pem: string;
    ca_expires_at: string;
    gateway_expires_at: string;
  } {
    return {
      ca_cert_pem: record.caCertPem,
      ca_key_pem: this.cipher.encrypt(record.caKeyPem),
      gateway_server_name: record.gatewayServerName,
      gateway_cert_pem: record.gatewayCertPem,
      gateway_key_pem: this.cipher.encrypt(record.gatewayKeyPem),
      ca_expires_at: record.caExpiresAt.toISOString(),
      gateway_expires_at: record.gatewayExpiresAt.toISOString(),
    };
  }

  async getClaudeEgressClientCert(
    projectId: string,
    userId: string,
  ): Promise<ClaudeEgressClientCertRecord | undefined> {
    const row = await this.db
      .selectFrom('claude_egress_client_certs')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? this.claudeEgressClientCertRowToRecord(row) : undefined;
  }

  /** Every stored client certificate — the source of the gateway's
   *  fingerprint→sandbox peer bindings. */
  async listClaudeEgressClientCerts(): Promise<ClaudeEgressClientCertRecord[]> {
    const rows = await this.db
      .selectFrom('claude_egress_client_certs')
      .selectAll()
      .orderBy('project_id', 'asc')
      .orderBy('user_id', 'asc')
      .execute();
    return rows.map((row) => this.claudeEgressClientCertRowToRecord(row));
  }

  /** Insert or replace a sandbox's client certificate, encrypting the key. A
   *  rotation upserts on the (project, person) key, dropping the superseded fingerprint. */
  async upsertClaudeEgressClientCert(record: ClaudeEgressClientCertRecord): Promise<void> {
    const values = {
      cert_pem: record.certPem,
      key_pem: this.cipher.encrypt(record.keyPem),
      fingerprint256: record.fingerprint256,
      expires_at: record.expiresAt.toISOString(),
    };
    await this.db
      .insertInto('claude_egress_client_certs')
      .values({ project_id: record.projectId, user_id: record.userId, ...values })
      .onConflict((oc) =>
        oc.columns(['project_id', 'user_id']).doUpdateSet({ ...values, updated_at: sql`now()` }),
      )
      .execute();
  }

  /** Drop one sandbox's client certificate, or every one of the project when no
   *  person is named (deprovision / revocation). */
  async deleteClaudeEgressClientCert(projectId: string, userId?: string): Promise<void> {
    let query = this.db
      .deleteFrom('claude_egress_client_certs')
      .where('project_id', '=', projectId);
    if (userId !== undefined) query = query.where('user_id', '=', userId);
    await query.execute();
  }

  private claudeEgressClientCertRowToRecord(row: {
    project_id: string;
    user_id: string;
    cert_pem: string;
    key_pem: string;
    fingerprint256: string;
    expires_at: Date | string;
  }): ClaudeEgressClientCertRecord {
    return {
      projectId: row.project_id,
      userId: row.user_id,
      certPem: row.cert_pem,
      keyPem: this.cipher.decrypt(row.key_pem),
      fingerprint256: row.fingerprint256,
      expiresAt: new Date(row.expires_at),
    };
  }
}
