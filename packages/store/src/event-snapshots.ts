import { sql, type Kysely } from 'kysely';
import { parseAgentEvent, type AgentEvent } from '@verity/events';
import type { Database } from './schema.js';

export class EventSnapshotStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}
  private get db(): Kysely<Database> {
    return this.getDb();
  }

  /** Restore listener discovery's baseline without reading the session's transcript. */
  async getLatestDevServersEvent(
    sessionId: string,
  ): Promise<Extract<AgentEvent, { t: 'dev_servers_changed' }> | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select('payload')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'dev_servers_changed')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success || parsed.data.t !== 'dev_servers_changed') {
      throw new Error(`corrupt listener snapshot in session ${sessionId}`);
    }
    return parsed.data;
  }

  /** Fetch one app snapshot without hydrating the surrounding transcript. */
  async getMcpAppEvent(
    sessionId: string,
    appId: string,
  ): Promise<Extract<AgentEvent, { t: 'mcp_app' }> | undefined> {
    const row = await this.db
      .selectFrom('events')
      .select('payload')
      .where('session_id', '=', sessionId)
      .where('type', '=', 'mcp_app')
      .where(sql<string>`payload->>'appId'`, '=', appId)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const parsed = parseAgentEvent(row.payload);
    if (!parsed.success || parsed.data.t !== 'mcp_app') throw new Error('Corrupt MCP app snapshot');
    return parsed.data;
  }
}
