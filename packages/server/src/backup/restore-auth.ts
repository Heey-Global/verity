import type { PoolClient } from 'pg';
import { deriveKeyFromPassword, keyMatchesVerifier } from '@verity/store';

/** Recovery verifies the global master password without installing a secret-store cipher. */
export async function authenticateRestoreAdministrator(
  client: Pick<PoolClient, 'query'>,
  password: string,
): Promise<boolean> {
  if (!password || password.length > 4096) return false;
  const meta = await client.query<{ salt: string; verifier: string }>(
    "SELECT salt, verifier FROM secret_key_meta WHERE id = 'global' AND EXISTS (SELECT 1 FROM users WHERE role = 'administrator' AND status = 'active')",
  );
  if (meta.rows.length !== 1) return false;
  const row = meta.rows[0]!;
  return keyMatchesVerifier(await deriveKeyFromPassword(password, row.salt), row.verifier);
}
