import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Who started the current detail mode. */
export type DetailModeStarter = 'app' | 'control';

export interface ServerMonitoringSettings {
  /** In-memory request, traffic and resource counters. On unless switched off. */
  measurementEnabled: boolean;
  /** Detail mode runs until this instant; null or past means it is off. */
  detailUntil: Date | null;
  detailStartedBy: DetailModeStarter | null;
}

export const DEFAULT_SERVER_MONITORING_SETTINGS: ServerMonitoringSettings = {
  measurementEnabled: true,
  detailUntil: null,
  detailStartedBy: null,
};

/**
 * The installation's monitoring settings (ADR 0032). A missing row means the
 * defaults: measurement on, detail mode off.
 */
export class ServerMonitoringSettingsStore {
  constructor(private readonly db: Kysely<Database>) {}

  async get(): Promise<ServerMonitoringSettings> {
    const row = await this.db
      .selectFrom('server_monitoring_settings')
      .select(['measurement_enabled', 'detail_until', 'detail_started_by'])
      .where('id', '=', 'global')
      .executeTakeFirst();
    if (row === undefined) return { ...DEFAULT_SERVER_MONITORING_SETTINGS };
    return {
      measurementEnabled: row.measurement_enabled,
      detailUntil: row.detail_until === null ? null : new Date(row.detail_until),
      detailStartedBy: row.detail_started_by,
    };
  }

  async setMeasurementEnabled(enabled: boolean): Promise<ServerMonitoringSettings> {
    return this.write({ measurement_enabled: enabled });
  }

  /** Starts or replaces detail mode; `until: null` stops it. */
  async setDetailMode(
    until: Date | null,
    startedBy: DetailModeStarter | null,
  ): Promise<ServerMonitoringSettings> {
    return this.write({
      detail_until: until,
      detail_started_by: until === null ? null : startedBy,
    });
  }

  private async write(patch: {
    measurement_enabled?: boolean;
    detail_until?: Date | null;
    detail_started_by?: DetailModeStarter | null;
  }): Promise<ServerMonitoringSettings> {
    await this.db
      .insertInto('server_monitoring_settings')
      .values({ id: 'global', ...patch, updated_at: new Date() })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({ ...patch, updated_at: sql`now()` }),
      )
      .execute();
    return this.get();
  }
}
