// Test-only reference model; never imported by production enrollment routes.
import { createPublicKey, verify } from 'node:crypto';
import { isEncrypted, type SealableSecretCipher } from '../../packages/store/src/crypto.js';

export type Transcript = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
];

export function encode(fields: Transcript): Buffer {
  if (
    fields.length !== 14 ||
    fields[0] !== 'verity.remote-enrollment.v1' ||
    !['initialize', 'commit', 'recover'].includes(fields[1]) ||
    fields
      .slice(0, 13)
      .some((value) => typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) ||
    !Number.isSafeInteger(fields[13]) ||
    fields[13] <= 0
  )
    throw new Error('transcript');
  return Buffer.from(JSON.stringify(fields), 'utf8');
}

export function checkProof(fields: Transcript, signature: string): boolean {
  try {
    const bytes = Buffer.from(signature, 'base64url');
    const publicBytes = Buffer.from(fields[7], 'base64url');
    if (
      bytes.length !== 64 ||
      bytes.toString('base64url') !== signature ||
      publicBytes.toString('base64url') !== fields[7]
    )
      return false;
    const key = createPublicKey({ key: publicBytes, type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, encode(fields), key, bytes);
  } catch {
    return false;
  }
}

interface Receipt {
  operation: string;
  device: string;
  token: string;
  until: number;
}
interface Row {
  operation: string;
  device: string;
  until: number;
  revoked: boolean;
  encrypted?: string;
}
export class RecoveryModel {
  constructor(
    private cipher: SealableSecretCipher,
    readonly rows = new Map<string, Row>(),
  ) {}
  commit(operation: string, device: string, token: string, now: number, duration: number): void {
    if (this.rows.has(operation)) throw new Error('consumed');
    if (this.cipher.isSealed()) throw new Error('locked');
    const until = now + duration;
    const encrypted = this.cipher.encrypt(JSON.stringify({ operation, device, token, until }));
    if (!isEncrypted(encrypted)) throw new Error('plaintext');
    this.rows.set(operation, { operation, device, until, revoked: false, encrypted });
  }
  recover(operation: string, device: string, now: number): string {
    const row = this.rows.get(operation);
    if (!row || row.device !== device || row.revoked || now >= row.until || !row.encrypted)
      throw new Error('rejected');
    if (!isEncrypted(row.encrypted)) throw new Error('plaintext');
    if (this.cipher.isSealed()) throw new Error('locked');
    const result = JSON.parse(this.cipher.decrypt(row.encrypted)) as Receipt;
    if (
      result.operation !== operation ||
      result.device !== device ||
      result.until !== row.until ||
      typeof result.token !== 'string'
    )
      throw new Error('binding');
    return result.token;
  }
  ack(operation: string, device: string, token: string, now: number): void {
    // The harness authenticates using the original token; production needs its verifier registry.
    if (this.recover(operation, device, now) !== token) throw new Error('rejected');
    delete this.rows.get(operation)!.encrypted;
  }
  revoke(operation: string): void {
    const row = this.rows.get(operation);
    if (row) {
      row.revoked = true;
      delete row.encrypted;
    }
  }
}
