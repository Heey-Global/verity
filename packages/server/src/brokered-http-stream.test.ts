import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { credentialSafeStream } from './brokered-http-stream.js';

async function read(chunks: Buffer[], credential: string): Promise<Buffer> {
  const output: Buffer[] = [];
  const stream = Readable.from(chunks).pipe(
    credentialSafeStream([{ value: credential, alias: 'TEST' }]),
  );
  for await (const chunk of stream) output.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(output);
}

describe('credential-safe binary response stream', () => {
  it('rejects raw and encoded echoes at every chunk boundary before flushing credential bytes', async () => {
    const token = 'ghs_server_only_stream_fixture';
    for (const value of [
      token,
      Buffer.from(token).toString('base64'),
      Buffer.from(token).toString('base64url'),
    ]) {
      for (let split = 1; split < value.length; split++) {
        await expect(
          read(
            [Buffer.from(`safe-prefix${value.slice(0, split)}`), Buffer.from(value.slice(split))],
            token,
          ),
        ).rejects.toThrow('broker response withheld');
      }
    }
  });
  it('preserves binary data and final bytes when no credential is present', async () => {
    const chunks = [Buffer.from([0, 255, 129, 1]), Buffer.from('pack-body'), Buffer.from([255, 0])];
    expect(await read(chunks, 'credential-that-is-not-present')).toEqual(Buffer.concat(chunks));
  });
});
