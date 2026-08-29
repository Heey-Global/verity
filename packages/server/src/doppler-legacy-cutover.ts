import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '@verity/store';

import type { DockerClient } from './docker.js';
import type { Provisioner } from './provisioner.js';
import { stopAndRemoveExistingContainer } from './provisioner.js';

interface LegacyCutoverRow {
  project_id: string;
  container_name: string;
  doppler_project: string | null;
  doppler_config: string | null;
  token_slug: string | null;
  token_ref: string | null;
  manual_credential: boolean;
  catalog_credential: boolean;
}

export interface LegacyDopplerTokenRevokeInput {
  project: string;
  config: string;
  slug: string;
  credential: Buffer;
}

const pendingRows = async (db: Kysely<Database>): Promise<LegacyCutoverRow[]> =>
  (
    await sql<LegacyCutoverRow>`
      select project_id, container_name, doppler_project, doppler_config, token_slug, token_ref,
             manual_credential, catalog_credential
      from doppler_legacy_cutovers
      where runtime_cutover_at is null
      order by project_id
    `.execute(db)
  ).rows;

const withCutoverLock = <T>(
  db: Kysely<Database>,
  run: (lockedDb: Kysely<Database>) => Promise<T>,
): Promise<T> =>
  db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(1129464146, 1146047564)`.execute(connection);
    try {
      return await run(connection);
    } finally {
      await sql`select pg_advisory_unlock(1129464146, 1146047564)`.execute(connection);
    }
  });

/**
 * Cut off every container that may still hold a legacy project credential before
 * the upgraded Server exposes any API. Repeated calls are safe after a crash.
 */
async function quarantineLegacyDopplerContainersOnce(
  db: Kysely<Database>,
  docker: DockerClient | undefined,
): Promise<number> {
  const rows = await pendingRows(db);
  if (rows.length > 0 && docker === undefined) {
    throw new Error('legacy Doppler cutover requires the project Docker runtime');
  }
  for (const row of rows) {
    await stopAndRemoveExistingContainer(docker!, row.container_name);
    // Destructive cleanup happens only after the credential-bearing runtime is
    // gone. A crash before this statement leaves recovery data intact; a crash
    // after it can only leave an already-quarantined project to retry.
    await sql`
      update project_settings
      set doppler_token = null, doppler_token_ref = null, doppler_minted_token = null
      where project_id = ${row.project_id}
    `.execute(db);
  }
  return rows.length;
}

export function quarantineLegacyDopplerContainers(
  db: Kysely<Database>,
  docker: DockerClient | undefined,
): Promise<number> {
  return withCutoverLock(db, (lockedDb) => quarantineLegacyDopplerContainersOnce(lockedDb, docker));
}

const inFlightCutovers = new WeakMap<Kysely<Database>, Promise<number>>();

/** Revoke old scoped tokens through the central identity, then rebuild clean containers. */
async function completeLegacyDopplerCutoverOnce(input: {
  db: Kysely<Database>;
  provisioner: Provisioner | undefined;
  readCredential: () => Promise<Buffer | undefined>;
  revoke: (input: LegacyDopplerTokenRevokeInput) => Promise<void>;
  validateBinding?:
    ((input: { project: string; config: string; credential: Buffer }) => Promise<void>) | undefined;
}): Promise<number> {
  const rows = await pendingRows(input.db);
  if (rows.length === 0) return 0;
  let credential: Buffer | undefined;
  let credentialRead = false;
  let completed = 0;
  try {
    for (const row of rows) {
      if (row.token_slug !== null || row.catalog_credential) {
        if (!credentialRead) {
          credential = await input.readCredential();
          credentialRead = true;
        }
        if (credential === undefined) {
          // Keep the revocation tombstone pending, but do not make unlock
          // impossible: the central identity can only be configured through the
          // unlocked settings API. Broker resolution remains fail-closed because
          // hasPendingLegacyDopplerCutover() still sees this row.
          continue;
        }
      }
      if (row.catalog_credential) {
        if (input.validateBinding === undefined) {
          throw new Error(`legacy Doppler catalog ${row.project_id} cannot be validated`);
        }
        const bindings = (
          await sql<{ doppler_project: string; doppler_config: string }>`
            select distinct doppler_project, doppler_config
            from secret_provider_bindings
            where project_id = ${row.project_id} and provider = 'doppler'
          `.execute(input.db)
        ).rows;
        for (const binding of bindings) {
          await input.validateBinding({
            project: binding.doppler_project,
            config: binding.doppler_config,
            credential: credential!,
          });
        }
      }
      if (row.token_slug !== null) {
        if (row.doppler_project === null || row.doppler_config === null) {
          throw new Error(`legacy Doppler token ${row.project_id} has no project mapping`);
        }
        await input.revoke({
          project: row.doppler_project,
          config: row.doppler_config,
          slug: row.token_slug,
          credential: credential!,
        });
      }
      const project = (
        await sql<{ state: string }>`
          select state from projects where id = ${row.project_id}
        `.execute(input.db)
      ).rows[0];
      if (project !== undefined && project.state !== 'absent') {
        if (input.provisioner?.recreateContainer === undefined) {
          throw new Error('legacy Doppler cutover requires the project provisioner');
        }
        await input.provisioner.recreateContainer(row.project_id, { confirmWarnings: true });
      }
      if (row.token_slug !== null) {
        await sql`
          update project_settings set doppler_minted_token_slug = null
          where project_id = ${row.project_id}
        `.execute(input.db);
      }
      if (row.catalog_credential) {
        await sql`
          delete from secret_provider_credentials credentials
          where exists (
            select 1 from secret_provider_bindings bindings
            where bindings.project_id = ${row.project_id}
              and bindings.provider = 'doppler'
              and bindings.credential_ref = credentials.credential_ref
          )
            and not exists (
              select 1 from secret_provider_bindings bindings
              where bindings.credential_ref = credentials.credential_ref
                and (
                  bindings.provider <> 'doppler'
                  or bindings.project_id <> ${row.project_id}
                )
            )
        `.execute(input.db);
        await sql`
          update secret_provider_bindings
          set credential_ref = 'secretref:broker/doppler'
          where project_id = ${row.project_id} and provider = 'doppler'
        `.execute(input.db);
      }
      if (!row.manual_credential) {
        await sql`delete from doppler_legacy_cutovers where project_id = ${row.project_id}`.execute(
          input.db,
        );
      } else {
        await sql`
          update doppler_legacy_cutovers set runtime_cutover_at = now()
          where project_id = ${row.project_id}
        `.execute(input.db);
      }
      completed += 1;
    }
    return completed;
  } finally {
    credential?.fill(0);
  }
}

/** Single-flight the cutover across unlock and concurrent broker requests. */
export function completeLegacyDopplerCutover(
  input: Parameters<typeof completeLegacyDopplerCutoverOnce>[0],
): Promise<number> {
  const active = inFlightCutovers.get(input.db);
  if (active !== undefined) return active;
  const run = withCutoverLock(input.db, (lockedDb) =>
    completeLegacyDopplerCutoverOnce({ ...input, db: lockedDb }),
  ).finally(() => {
    if (inFlightCutovers.get(input.db) === run) inFlightCutovers.delete(input.db);
  });
  inFlightCutovers.set(input.db, run);
  return run;
}

export async function hasPendingLegacyDopplerCutover(db: Kysely<Database>): Promise<boolean> {
  return (await pendingRows(db)).length > 0;
}
