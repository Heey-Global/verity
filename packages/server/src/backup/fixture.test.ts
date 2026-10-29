import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decryptStream, openMetadata, recoverHostKeys } from './crypto.js';
import { parseManifest } from './format.js';

describe('committed backup format compatibility', () => {
  it('reads format v1 without regenerating the fixture', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/v1.json', import.meta.url), 'utf8'),
    ) as {
      recoveryKey: string;
      hostKeys: string;
      manifest: string;
      ciphertext: string;
      plaintext: string;
    };
    const host = await recoverHostKeys(
      fixture.recoveryKey,
      Buffer.from(fixture.hostKeys, 'base64'),
    );
    expect(host.recipient.startsWith('age1')).toBe(true);
    const manifest = parseManifest(
      await openMetadata(fixture.recoveryKey, Buffer.from(fixture.manifest, 'base64')),
      '11111111-1111-4111-8111-111111111111-r1',
      1,
    );
    expect(manifest.files[0]!.path).toBe('fixture.txt');
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(Buffer.from(fixture.ciphertext, 'base64'));
        c.close();
      },
    });
    const plaintext = await new Response(await decryptStream(fixture.recoveryKey, input)).text();
    expect(plaintext).toBe(fixture.plaintext);
  });
});
