import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function tlsFromEnvironment(): Promise<{ key: Buffer; cert: Buffer } | undefined> {
  const keyPath = process.env.VERITY_TLS_KEY_PATH?.trim();
  const certPath = process.env.VERITY_TLS_CERT_PATH?.trim();
  if (!keyPath && !certPath) return undefined;
  if (!keyPath || !certPath) {
    throw new Error('VERITY_TLS_KEY_PATH and VERITY_TLS_CERT_PATH must be configured together');
  }
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

export function managedClientIdentitySecret(key: Buffer): Buffer {
  return createHash('sha256').update('verity.managed-client-identity.v1\0').update(key).digest();
}
