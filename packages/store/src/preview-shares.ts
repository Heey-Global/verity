import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, PublicPreviewSharesTable } from './schema.js';

export interface LocalPreviewShareRecord {
  id: string;
  projectId: string;
  sessionId: string;
  managedInstanceId: string | null;
  networkPort: number;
  url: string;
  targetPort: number | null;
  staticPath: string | null;
  connectorSecret: string;
  state: 'active' | 'revoking';
  expiresAt: Date;
}

export type PublicPreviewShareState =
  'creating' | 'active' | 'revoking' | 'revoked' | 'expired' | 'failed';

export interface PublicPreviewShareRecord {
  managedInstanceId?: string | null;
  pinLocked?: boolean;
  id: string;
  projectId: string;
  devServerId: string | null;
  containerGeneration: string;
  targetPort: number | null;
  targetKind?: 'dev-server' | 'static-folder';
  staticPath?: string | null;
  sessionId?: string | null;
  state: PublicPreviewShareState;
  publicOrigin: string;
  edgeUrl: string;
  pinHash: string;
  pin: string | null;
  connectorToken: string;
  sessionSecret: string;
  connectorContainerName: string;
  connectorContainerId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  failure: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicPreviewShareCreateInput {
  managedInstanceId?: string | null;
  id: string;
  projectId: string;
  devServerId: string | null;
  containerGeneration: string;
  targetPort: number | null;
  targetKind?: 'dev-server' | 'static-folder';
  staticPath?: string | null;
  sessionId?: string | null;
  publicOrigin: string;
  edgeUrl: string;
  pinHash: string;
  pin: string;
  connectorToken: string;
  sessionSecret: string;
  connectorContainerName: string;
  expiresAt: Date;
}

export class PreviewShareStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly encryptSecret: (value: string | null) => string | null,
    private readonly decryptSecret: (value: string | null) => string | null,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  async createLocalPreviewShare(input: Omit<LocalPreviewShareRecord, 'state'>): Promise<void> {
    await this.db
      .insertInto('local_preview_shares')
      .values({
        id: input.id,
        project_id: input.projectId,
        session_id: input.sessionId,
        managed_instance_id: input.managedInstanceId,
        network_port: input.networkPort,
        url: input.url,
        target_port: input.targetPort,
        static_path: input.staticPath,
        connector_secret: this.encryptSecret(input.connectorSecret)!,
        state: 'active',
        expires_at: input.expiresAt.toISOString(),
      })
      .execute();
  }

  async listLocalPreviewShares(): Promise<LocalPreviewShareRecord[]> {
    const rows = await this.db.selectFrom('local_preview_shares').selectAll().execute();
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      managedInstanceId: row.managed_instance_id,
      networkPort: row.network_port,
      url: row.url,
      targetPort: row.target_port,
      staticPath: row.static_path,
      connectorSecret: this.decryptSecret(row.connector_secret)!,
      state: row.state,
      expiresAt: row.expires_at,
    }));
  }

  /** Follow a managed listener without changing its public binding. */
  async updateLocalPreviewShareTarget(id: string, targetPort: number): Promise<void> {
    await this.db
      .updateTable('local_preview_shares')
      .set({ target_port: targetPort })
      .where('id', '=', id)
      .where('state', '=', 'active')
      .where('static_path', 'is', null)
      .execute();
  }

  /** Persist stop intent before removing sockets or containers. */
  async revokeLocalPreviewShare(id: string): Promise<void> {
    await this.db
      .updateTable('local_preview_shares')
      .set({ state: 'revoking' })
      .where('id', '=', id)
      .execute();
  }

  async deleteLocalPreviewShare(id: string): Promise<void> {
    await this.db.deleteFrom('local_preview_shares').where('id', '=', id).execute();
  }

  private publicPreviewShare(row: Selectable<PublicPreviewSharesTable>): PublicPreviewShareRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      devServerId: row.dev_server_id,
      managedInstanceId: row.managed_instance_id,
      containerGeneration: row.container_generation,
      targetPort: row.target_port,
      targetKind: row.target_kind,
      staticPath: row.static_path,
      sessionId: row.session_id,
      state: row.state as PublicPreviewShareState,
      publicOrigin: row.public_origin,
      edgeUrl: row.edge_url,
      pinHash: this.decryptSecret(row.pin_hash_secret) ?? '',
      pin: this.decryptSecret(row.pin_secret)!,
      pinLocked: row.pin_locked,
      connectorToken: this.decryptSecret(row.connector_token_secret) ?? '',
      sessionSecret: this.decryptSecret(row.session_secret) ?? '',
      connectorContainerName: row.connector_container_name,
      connectorContainerId: row.connector_container_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      failure: row.failure,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createPublicPreviewShare(
    input: PublicPreviewShareCreateInput,
    getPublicPreviewShare: (id: string) => Promise<PublicPreviewShareRecord | undefined>,
  ): Promise<PublicPreviewShareRecord> {
    const row = await this.db
      .insertInto('public_preview_shares')
      .values({
        id: input.id,
        project_id: input.projectId,
        dev_server_id: input.devServerId,
        managed_instance_id: input.managedInstanceId ?? null,
        container_generation: input.containerGeneration,
        target_port: input.targetPort,
        target_kind: input.targetKind ?? 'dev-server',
        static_path: input.staticPath ?? null,
        session_id: input.sessionId ?? null,
        state: 'creating',
        public_origin: input.publicOrigin,
        edge_url: input.edgeUrl,
        pin_hash_secret: this.encryptSecret(input.pinHash) ?? '',
        pin_secret: this.encryptSecret(input.pin),
        connector_token_secret: this.encryptSecret(input.connectorToken) ?? '',
        session_secret: this.encryptSecret(input.sessionSecret) ?? '',
        connector_container_name: input.connectorContainerName,
        expires_at: input.expiresAt.toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The control event may precede this insert; consume the durable snapshot.
    await this.db
      .updateTable('public_preview_shares')
      .set({ pin_locked: true })
      .where('id', '=', row.id)
      .where('id', 'in', this.db.selectFrom('public_preview_pin_locks').select('share_id'))
      .execute();
    await this.db.deleteFrom('public_preview_pin_locks').where('share_id', '=', row.id).execute();
    return (await getPublicPreviewShare(row.id))!;
  }

  /** PIN lockout blocks new authentication, never the active connector or cookies. */
  async lockPublicPreviewSharePin(id: string): Promise<void> {
    await this.db
      .insertInto('public_preview_pin_locks')
      .values({ share_id: id })
      .onConflict((conflict) => conflict.column('share_id').doNothing())
      .execute();
    const updated = await this.db
      .updateTable('public_preview_shares')
      .set({ pin_locked: true, updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (updated) {
      await this.db.deleteFrom('public_preview_pin_locks').where('share_id', '=', id).execute();
    }
    // Unknown snapshots cannot belong to a live share after the maximum 30-day TTL.
    await this.db
      .deleteFrom('public_preview_pin_locks')
      .where('created_at', '<', new Date(Date.now() - 31 * 86400_000))
      .execute();
  }

  async addPendingUplinkShareRemoval(shareId: string): Promise<void> {
    await this.db
      .insertInto('uplink_pending_share_removals')
      .values({ share_id: shareId })
      .onConflict((conflict) => conflict.column('share_id').doNothing())
      .execute();
  }

  async listPendingUplinkShareRemovals(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('uplink_pending_share_removals')
      .select('share_id')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => row.share_id);
  }

  async deletePendingUplinkShareRemoval(shareId: string): Promise<void> {
    await this.db
      .deleteFrom('uplink_pending_share_removals')
      .where('share_id', '=', shareId)
      .execute();
  }

  async getPublicPreviewShare(id: string): Promise<PublicPreviewShareRecord | undefined> {
    const row = await this.db
      .selectFrom('public_preview_shares')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : this.publicPreviewShare(row);
  }

  async listPublicPreviewShares(projectId?: string): Promise<PublicPreviewShareRecord[]> {
    let query = this.db.selectFrom('public_preview_shares').selectAll();
    if (projectId !== undefined) query = query.where('project_id', '=', projectId);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map((row) => this.publicPreviewShare(row));
  }

  /** Compare-and-set is the lifecycle fence shared by create, stop, expiry and
   * restart reconciliation. A stale worker cannot resurrect a revoked share. */
  async transitionPublicPreviewShare(
    id: string,
    from: readonly PublicPreviewShareState[],
    to: PublicPreviewShareState,
    patch: {
      connectorContainerId?: string | null;
      targetPort?: number;
      containerGeneration?: string;
      failure?: string | null;
      revokedAt?: Date | null;
    } = {},
  ): Promise<PublicPreviewShareRecord | undefined> {
    if (from.length === 0) return undefined;
    const row = await this.db
      .updateTable('public_preview_shares')
      .set({
        state: to,
        updated_at: sql`now()`,
        ...(patch.connectorContainerId === undefined
          ? {}
          : { connector_container_id: patch.connectorContainerId }),
        ...(patch.targetPort === undefined ? {} : { target_port: patch.targetPort }),
        ...(patch.containerGeneration === undefined
          ? {}
          : { container_generation: patch.containerGeneration }),
        ...(patch.failure === undefined ? {} : { failure: patch.failure }),
        ...(patch.revokedAt === undefined
          ? {}
          : { revoked_at: patch.revokedAt?.toISOString() ?? null }),
      })
      .where('id', '=', id)
      .where('state', 'in', [...from])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : this.publicPreviewShare(row);
  }

  async listPublicPreviewSharesDue(now = new Date()): Promise<PublicPreviewShareRecord[]> {
    const rows = await this.db
      .selectFrom('public_preview_shares')
      .selectAll()
      .where('state', 'in', ['creating', 'active', 'revoking'])
      .where('expires_at', '<=', now)
      .execute();
    return rows.map((row) => this.publicPreviewShare(row));
  }
}
