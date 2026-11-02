import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  confirmRecoveryKey,
  decodeRecoveryKey,
  decryptStream,
  encryptStream,
  generateBackupKeys,
  openMetadata,
  recoverHostKeys,
  sealHostKeyBundle,
  sealMetadata,
} from './crypto.js';
import { chunkContent, MAX_CHUNK } from './chunking.js';

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
async function bytes(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe('backup crypto', () => {
  it('confirms the complete key, detects mistypes and keeps decryption material off host state', async () => {
    const { recoveryKey, host } = await generateBackupKeys();
    await confirmRecoveryKey(recoveryKey, host);
    expect(JSON.stringify(host)).not.toContain(decodeRecoveryKey(recoveryKey).identity);
    expect(() => decodeRecoveryKey(recoveryKey.slice(0, -4) + 'AAAA')).toThrow();
    expect(() => decodeRecoveryKey('x'.repeat(2000))).toThrow();
    const other = await generateBackupKeys();
    await expect(confirmRecoveryKey(other.recoveryKey, host)).rejects.toThrow();
  });

  it('restores host keys from the encrypted repository bundle without a local index', async () => {
    const { recoveryKey, host } = await generateBackupKeys();
    const sealed = await sealHostKeyBundle(host);
    expect(sealed.includes(Buffer.from(host.signingKey))).toBe(false);
    expect(await recoverHostKeys(recoveryKey, sealed)).toEqual(host);
  });

  it('authenticates metadata before parsing and rejects wrong keys, damage and truncation', async () => {
    const { recoveryKey, host } = await generateBackupKeys();
    const original = Buffer.from('{"private-path":"/projects/example"}');
    const sealed = await sealMetadata(host, original);
    expect(await openMetadata(recoveryKey, sealed)).toEqual(original);
    expect(sealed.includes(original)).toBe(false);
    const other = await generateBackupKeys();
    await expect(openMetadata(other.recoveryKey, sealed)).rejects.toThrow();
    for (const offset of [0, 64, sealed.length - 1]) {
      const damaged = Buffer.from(sealed);
      damaged[offset]! ^= 1;
      await expect(openMetadata(recoveryKey, damaged)).rejects.toThrow();
    }
    await expect(openMetadata(recoveryKey, sealed.subarray(0, -1))).rejects.toThrow();
    await expect(sealMetadata(host, Buffer.alloc(8 * 1024 * 1024 + 1))).rejects.toThrow();
  });

  it('streams multi-frame objects with random encryption and rejects missing or reordered frames', async () => {
    const { recoveryKey, host } = await generateBackupKeys();
    const original = randomBytes(256 * 1024);
    const first = await bytes(await encryptStream(host.recipient, stream(original)));
    const second = await bytes(await encryptStream(host.recipient, stream(original)));
    expect(first.equals(second)).toBe(false);
    expect((await bytes(await decryptStream(recoveryKey, stream(first)))).equals(original)).toBe(
      true,
    );
    await expect(
      bytes(await decryptStream(recoveryKey, stream(first.subarray(0, -1)))),
    ).rejects.toThrow();
    const swapped = Buffer.from(first);
    // Corrupt the authenticated payload order without relying on an age header length.
    const tail = swapped.subarray(swapped.length - 1000);
    const saved = Buffer.from(tail.subarray(0, 500));
    tail.copyWithin(0, 500);
    saved.copy(tail, 500);
    await expect(bytes(await decryptStream(recoveryKey, stream(swapped)))).rejects.toThrow();
  });
});

describe('content-defined chunking', () => {
  async function chunks(input: Buffer, stride: number): Promise<Buffer[]> {
    async function* source() {
      for (let i = 0; i < input.length; i += stride) yield input.subarray(i, i + stride);
    }
    const result: Buffer[] = [];
    for await (const block of chunkContent(source())) result.push(block);
    return result;
  }
  it('is independent of upstream frame boundaries and preserves every byte', async () => {
    const input = randomBytes(3 * MAX_CHUNK);
    const first = await chunks(input, 10001);
    const digest = (blocks: Buffer[]) =>
      blocks.map((block) => createHash('sha256').update(block).digest('hex'));
    expect(digest(first)).toEqual(digest(await chunks(input, input.length)));
    expect(Buffer.concat(first).equals(input)).toBe(true);
    expect(first.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(await chunks(Buffer.alloc(0), 1)).toEqual([]);
  });
  it('resynchronizes chunk boundaries after an insertion', async () => {
    const input = randomBytes(8 * MAX_CHUNK);
    const before = await chunks(input, 65536);
    const after = await chunks(Buffer.concat([Buffer.from('insert'), input]), 65536);
    const reused = after.filter((c) => before.some((previous) => previous.equals(c)));
    expect(reused.reduce((sum, c) => sum + c.length, 0)).toBeGreaterThan(input.length / 2);
  });
});
