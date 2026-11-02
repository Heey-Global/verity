import { fileURLToPath } from 'node:url';
import { encryptStream } from './crypto.js';
import { readBounded } from './repository.js';
import { identityHelperRequestSchema, sealCaIdentityReceipt } from './identity-receipt.js';

/** Invoked only by the root-owned host helper in a networkless, read-only container. */
export async function encryptCaForRecipient(
  recipient: string,
  source: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  if (!/^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(recipient))
    throw new Error('Invalid backup recipient');
  return encryptStream(recipient, source);
}

async function main(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1024) throw new Error('Invalid backup recipient');
  }
  const request = identityHelperRequestSchema.parse(JSON.parse(input));
  const key = await readBounded('/run/verity-backup-ca.pem', 64 * 1024);
  try {
    const certificate = await readBounded('/run/verity-backup-ca-cert.pem', 64 * 1024);
    const receipt = await sealCaIdentityReceipt(request, key, certificate);
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(receipt, (error) => (error ? reject(error) : resolve())),
    );
  } finally {
    key.fill(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write('CA backup encryption failed\n');
    process.exitCode = 1;
  });
}
