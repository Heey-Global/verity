import type { Kysely } from 'kysely';
import type { Database } from './schema.js';

export class PackageProtectionStore {
  constructor(private readonly getDb: () => Kysely<Database>) {}

  async getPackageProtectionDecision(
    projectId: string,
  ): Promise<'protected' | 'skipped' | 'undecided'> {
    const row = await this.getDb()
      .selectFrom('project_package_protection')
      .select('decision')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return row?.decision ?? 'undecided';
  }

  async setPackageProtectionDecision(
    projectId: string,
    decision: 'protected' | 'skipped',
  ): Promise<void> {
    await this.getDb()
      .insertInto('project_package_protection')
      .values({ project_id: projectId, decision })
      .onConflict((conflict) => conflict.column('project_id').doUpdateSet({ decision }))
      .execute();
  }
}
