import type { Kysely } from 'kysely';
import type { EgressDestinationMutation } from './egress-destination-mutation.js';
import type { Database } from './schema.js';

export interface HttpMcpConnectionRecord {
  id: string;
  ownerUserId?: string;
  name: string;
  url: string;
  /** Decrypted only at the trusted store boundary; public APIs must project this out. */
  authorization: string | null;
  authType?: 'none' | 'static' | 'oauth';
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  oauthTokenAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  oauthScopes?: string | null;
  oauthAccessToken?: string | null;
  oauthRefreshToken?: string | null;
  oauthExpiresAt?: Date | null;
  enabled: boolean;
}

/**
 * Whether a turn run for `userId` may use this HTTP MCP connection (ADR 0023 §3).
 * A connection that carries a credential belongs to its owner and is usable only
 * in the owner's turns; a credential-free server is project configuration and
 * usable by everyone. A turn without an initiator gets no credentialed
 * connection at all — never the administrator's as a fallback.
 */
export function httpMcpConnectionUsableBy(
  connection: Pick<HttpMcpConnectionRecord, 'ownerUserId' | 'authType' | 'authorization'>,
  userId: string | undefined,
): boolean {
  const credentialFree =
    connection.authorization === null && (connection.authType ?? 'none') === 'none';
  if (credentialFree) return true;
  return userId !== undefined && connection.ownerUserId === userId;
}

export interface ProjectMcpBindingRecord {
  projectId: string;
  connectionId: string;
  enabled: boolean;
}

export class HttpMcpConnectionStore {
  constructor(
    private readonly getDb: () => Kysely<Database>,
    private readonly encryptSecret: (value: string | null) => string | null,
    private readonly decryptSecret: (value: string | null) => string | null,
    private readonly egressDestinationMutation: EgressDestinationMutation,
  ) {}

  private get db(): Kysely<Database> {
    return this.getDb();
  }

  async upsertHttpMcpConnection(record: HttpMcpConnectionRecord): Promise<void> {
    return this.egressDestinationMutation(async () => {
      await this.db
        .insertInto('http_mcp_connections')
        .values({
          id: record.id,
          ...(record.ownerUserId === undefined ? {} : { owner_user_id: record.ownerUserId }),
          name: record.name,
          url: record.url,
          authorization: this.encryptSecret(record.authorization),
          auth_type: record.authType ?? (record.authorization === null ? 'none' : 'static'),
          oauth_client_id: record.oauthClientId ?? null,
          oauth_token_auth_method: record.oauthTokenAuthMethod ?? 'client_secret_post',
          oauth_client_secret: this.encryptSecret(record.oauthClientSecret ?? null),
          oauth_authorization_endpoint: record.oauthAuthorizationEndpoint ?? null,
          oauth_token_endpoint: record.oauthTokenEndpoint ?? null,
          oauth_scopes: record.oauthScopes ?? null,
          oauth_access_token: this.encryptSecret(record.oauthAccessToken ?? null),
          oauth_refresh_token: this.encryptSecret(record.oauthRefreshToken ?? null),
          oauth_expires_at: record.oauthExpiresAt?.toISOString() ?? null,
          enabled: record.enabled,
        })
        .onConflict((conflict) =>
          conflict.column('id').doUpdateSet({
            name: record.name,
            url: record.url,
            authorization: this.encryptSecret(record.authorization),
            auth_type: record.authType ?? (record.authorization === null ? 'none' : 'static'),
            oauth_client_id: record.oauthClientId ?? null,
            oauth_token_auth_method: record.oauthTokenAuthMethod ?? 'client_secret_post',
            oauth_client_secret: this.encryptSecret(record.oauthClientSecret ?? null),
            oauth_authorization_endpoint: record.oauthAuthorizationEndpoint ?? null,
            oauth_token_endpoint: record.oauthTokenEndpoint ?? null,
            oauth_scopes: record.oauthScopes ?? null,
            oauth_access_token: this.encryptSecret(record.oauthAccessToken ?? null),
            oauth_refresh_token: this.encryptSecret(record.oauthRefreshToken ?? null),
            oauth_expires_at: record.oauthExpiresAt?.toISOString() ?? null,
            enabled: record.enabled,
          }),
        )
        .execute();
    });
  }

  async listHttpMcpConnections(ownerUserId?: string): Promise<HttpMcpConnectionRecord[]> {
    let query = this.db
      .selectFrom('http_mcp_connections')
      .selectAll()
      .orderBy('name', 'asc')
      .orderBy('id', 'asc');
    if (ownerUserId !== undefined) query = query.where('owner_user_id', '=', ownerUserId);
    const rows = await query.execute();
    return rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
      name: row.name,
      url: row.url,
      authorization: this.decryptSecret(row.authorization),
      authType: row.auth_type as NonNullable<HttpMcpConnectionRecord['authType']>,
      oauthClientId: row.oauth_client_id,
      oauthTokenAuthMethod: row.oauth_token_auth_method as NonNullable<
        HttpMcpConnectionRecord['oauthTokenAuthMethod']
      >,
      oauthClientSecret: this.decryptSecret(row.oauth_client_secret),
      oauthAuthorizationEndpoint: row.oauth_authorization_endpoint,
      oauthTokenEndpoint: row.oauth_token_endpoint,
      oauthScopes: row.oauth_scopes,
      oauthAccessToken: this.decryptSecret(row.oauth_access_token),
      oauthRefreshToken: this.decryptSecret(row.oauth_refresh_token),
      oauthExpiresAt: row.oauth_expires_at,
      enabled: row.enabled,
    }));
  }

  /** Persist freshly issued OAuth tokens without resurrecting a connection that
   * was deleted while the provider request was in flight. */
  async updateHttpMcpOAuthTokens(
    id: string,
    tokens: { accessToken: string; refreshToken: string | null; expiresAt: Date | null },
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('http_mcp_connections')
      .set({
        oauth_access_token: this.encryptSecret(tokens.accessToken),
        oauth_refresh_token: this.encryptSecret(tokens.refreshToken),
        oauth_expires_at: tokens.expiresAt?.toISOString() ?? null,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async deleteHttpMcpConnection(id: string): Promise<boolean> {
    return this.egressDestinationMutation(async () => {
      const result = await this.db
        .deleteFrom('http_mcp_connections')
        .where('id', '=', id)
        .executeTakeFirst();
      return (result.numDeletedRows ?? 0n) > 0n;
    });
  }

  async upsertProjectMcpBinding(binding: ProjectMcpBindingRecord): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom('projects')
        .select('id')
        .where('id', '=', binding.projectId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (binding.enabled) {
        const existing = await transaction
          .selectFrom('project_mcp_bindings')
          .select(['connection_id', 'enabled'])
          .where('project_id', '=', binding.projectId)
          .execute();
        const alreadyEnabled = existing.some(
          (row) => row.connection_id === binding.connectionId && row.enabled,
        );
        if (!alreadyEnabled && existing.filter((row) => row.enabled).length >= 16) {
          throw new Error('project MCP connection limit exceeded');
        }
      }
      await transaction
        .insertInto('project_mcp_bindings')
        .values({
          project_id: binding.projectId,
          connection_id: binding.connectionId,
          enabled: binding.enabled,
        })
        .onConflict((conflict) =>
          conflict.columns(['project_id', 'connection_id']).doUpdateSet({
            enabled: binding.enabled,
          }),
        )
        .execute();
    });
  }

  async listProjectMcpBindings(projectId: string): Promise<ProjectMcpBindingRecord[]> {
    const rows = await this.db
      .selectFrom('project_mcp_bindings')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('connection_id', 'asc')
      .execute();
    return rows.map((row) => ({
      projectId: row.project_id,
      connectionId: row.connection_id,
      enabled: row.enabled,
    }));
  }

  async deleteProjectMcpBinding(projectId: string, connectionId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('project_mcp_bindings')
      .where('project_id', '=', projectId)
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
