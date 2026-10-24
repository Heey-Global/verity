import { installRandomUUID } from './webRandomUUID';

function fakeCrypto(fill: number): Partial<Crypto> {
  return {
    getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
      if (array) new Uint8Array(array.buffer).fill(fill);
      return array;
    },
  };
}

// Without this, every screen that mints a session or reply id crashes the web app
// on a plain-http origin, which is how the dev server's LAN address is served.
describe('installRandomUUID', () => {
  it('adds a version 4 UUID generator where the browser has none', () => {
    const crypto = fakeCrypto(0xff);
    expect(installRandomUUID(crypto)).toBe(true);
    expect(crypto.randomUUID!()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(fakeCryptoWith(0).randomUUID!()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('leaves an existing implementation alone', () => {
    const native = () => '11111111-1111-1111-1111-111111111111' as const;
    const crypto: Partial<Crypto> = { ...fakeCrypto(0), randomUUID: native };
    expect(installRandomUUID(crypto)).toBe(false);
    expect(crypto.randomUUID).toBe(native);
  });

  it('does nothing without a source of randomness', () => {
    const crypto: Partial<Crypto> = {};
    expect(installRandomUUID(crypto)).toBe(false);
    expect(installRandomUUID(undefined)).toBe(false);
    expect(crypto.randomUUID).toBeUndefined();
  });
});

function fakeCryptoWith(fill: number): Partial<Crypto> {
  const crypto = fakeCrypto(fill);
  installRandomUUID(crypto);
  return crypto;
}
