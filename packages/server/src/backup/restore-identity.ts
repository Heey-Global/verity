import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { Readable } from 'node:stream';
import { openBackupPath } from './git.js';
import { decryptStream } from './crypto.js';

async function readIdentityFile(root: string, name: string): Promise<Buffer> {
  const file = await openBackupPath(root, `identity/${name}`, false);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('Invalid restored identity file');
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size) throw new Error('Restored identity file changed');
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** The five allowlisted files must describe one identity, including during a concurrent rotation. */
export function validateReadableIdentity(files: ReadonlyMap<string, Buffer>): {
  deploymentId: string;
  ca: X509Certificate;
} {
  const required = (name: string): Buffer => {
    const bytes = files.get(name);
    if (!bytes) throw new Error('Incomplete deployment identity');
    return bytes;
  };
  const deploymentId = required('deployment-id').toString('utf8').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(deploymentId))
    throw new Error('Invalid deployment identity');
  const pairing = createPrivateKey(required('pairing-identity.pem'));
  const ca = new X509Certificate(required('tls-ca-cert.pem'));
  const tls = new X509Certificate(required('tls-cert.pem'));
  const tlsPrivate = createPrivateKey(required('tls-key.pem'));
  if (
    pairing.asymmetricKeyType !== 'ed25519' ||
    !ca.ca ||
    !ca.verify(ca.publicKey) ||
    !tls.verify(ca.publicKey) ||
    !tls.checkIssued(ca) ||
    !tls.publicKey.equals(createPublicKey(tlsPrivate))
  )
    throw new Error('Deployment identity files do not match');
  return { deploymentId, ca };
}

/** Returns the CA private key only to the installer worker; it is never written during a probe/trial. */
export async function verifyRestoredIdentity(
  root: string,
  recoveryKey: string,
  signal?: AbortSignal,
): Promise<{ deploymentId: string; caPrivateKey: Buffer }> {
  let caPrivateKey: Buffer | undefined;
  let verified = false;
  try {
    const files = new Map<string, Buffer>();
    for (const name of [
      'deployment-id',
      'pairing-identity.pem',
      'tls-ca-cert.pem',
      'tls-cert.pem',
      'tls-key.pem',
    ])
      files.set(name, await readIdentityFile(root, name));
    const { deploymentId, ca } = validateReadableIdentity(files);
    const ciphertext = await readIdentityFile(root, 'ca-key.age');
    const decrypted = await decryptStream(
      recoveryKey,
      Readable.toWeb(Readable.from([ciphertext])) as ReadableStream<Uint8Array>,
      signal,
    );
    const reader = decrypted.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        chunks.push(part.value);
        if (size > 64 * 1024) throw new Error();
      }
      caPrivateKey = Buffer.concat(chunks, size);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
      for (const chunk of chunks) chunk.fill(0);
    }
    if (!ca.publicKey.equals(createPublicKey(createPrivateKey(caPrivateKey)))) {
      throw new Error();
    }
    verified = true;
    return { deploymentId, caPrivateKey };
  } catch {
    throw new Error('Restored identity is incomplete, corrupt or does not match its CA');
  } finally {
    if (!verified) caPrivateKey?.fill(0);
  }
}
