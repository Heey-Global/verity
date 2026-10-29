import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import pg from 'pg';
import { assertRestoreDatabaseAuthority } from './restore-database-authority.js';
import { authenticateRestoreAdministrator } from './restore-auth.js';
import { BackupDeviceReview } from './device-review.js';
import { readBounded } from './repository.js';
import { createRestoreTrial } from './restore-trial.js';
import { z } from 'zod';

/** This mode cannot start projects, normal API routes, schedulers or the CA helper. */
export async function startRestoreTrial(environment: NodeJS.ProcessEnv): Promise<void> {
  const root = environment['VERITY_RESTORE_STATE'];
  const connectionString = environment['VERITY_RESTORE_DATABASE_URL'];
  if (!root || !isAbsolute(root) || normalize(root) !== root || root === '/' || !connectionString)
    throw new Error('Recovery trial requires private installer state and an isolated database');
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error('Recovery trial state must be an owned private directory');
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^(verity_restore_[a-f0-9]{32}|verity)$/.test(url.pathname.slice(1)) ||
    url.search
  )
    throw new Error('Recovery trial requires an isolated restore database');
  const pool = new pg.Pool({
    connectionString,
    max: 1,
    statement_timeout: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', () => {
    process.exitCode = 1;
  });
  try {
    const target = await pool.query<{ name: string }>('SELECT current_database() AS name');
    if (target.rows[0]?.name !== url.pathname.slice(1))
      throw new Error('Recovery database target mismatch');
    const authority = z
      .object({
        id: z.string().uuid(),
        installationId: z.string().uuid(),
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
        target: z.enum(['staging', 'canonical']),
      })
      .strict()
      .parse(JSON.parse((await readBounded(join(root, 'authority'), 4096)).toString()));
    if (
      url.pathname.slice(1) !==
        (authority.target === 'canonical'
          ? 'verity'
          : 'verity_restore_' + authority.id.replaceAll('-', '')) ||
      url.username !== (authority.target === 'canonical' ? 'verity' : 'restore')
    )
      throw new Error('Recovery trial authority database mismatch');
    const phase = await assertRestoreDatabaseAuthority(pool, {
      id: authority.id,
      installationId: authority.installationId,
      verified: { manifestHash: authority.manifestHash },
    });
    if (authority.target === 'canonical' && phase !== 'canonical')
      throw new Error('Canonical recovery database is not prepared');
    const inventorySchema = z
      .object({
        devices: z.array(z.string().min(1).max(256)).max(10000),
        revokedIds: z.array(z.string().min(1).max(256)).max(10000),
        findings: z.array(z.string().max(4096)).max(10000),
      })
      .strict();
    const app = createRestoreTrial({
      review: new BackupDeviceReview(root),
      authenticate: (password) => authenticateRestoreAdministrator(pool, password),
      inventory: async () =>
        inventorySchema.parse(
          JSON.parse((await readBounded(join(root, 'devices'), 8 * 1024 * 1024)).toString()),
        ),
      removeOtherTokens: async (allowed) => {
        await pool.query('DELETE FROM auth_tokens WHERE NOT (id = ANY($1::text[]))', [allowed]);
      },
    });
    app.addHook('onClose', async () => {
      await pool.end();
    });
    await app.listen({ path: join(root, 'trial.sock') });
    const stop = () => {
      void app.close();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    await pool.end();
    throw error;
  }
}
