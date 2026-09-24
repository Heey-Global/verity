import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSealableSecretCipher } from '../../packages/store/src/crypto.js';
import { checkProof, encode, RecoveryModel, type Transcript } from './model.js';

const contract = readFileSync(
  new URL('../../docs/protocols/uplink-enrollment-v1.md', import.meta.url),
  'utf8',
);
const storage = readFileSync(
  new URL('../../docs/protocols/uplink-enrollment-storage-v1.md', import.meta.url),
  'utf8',
);
const duration = Number(storage.match(/committedAt \+ (\d+)/)?.[1]);
const vector = JSON.parse(readFileSync(new URL('./vector.json', import.meta.url), 'utf8')) as {
  fields: Transcript;
  signature: string;
  hex: string;
};

describe('enrollment reference proof', () => {
  it('matches the documented field order and fixed cross-language vector', () => {
    const names = contract.match(/`\["verity.remote-enrollment.v1", ([^\]]+)\]`/)?.[1].split(', ');
    expect(names).toEqual([
      'action',
      'serverId',
      'installationId',
      'purpose',
      'invitationId',
      'operationId',
      'deviceKey',
      'sessionId',
      'redemptionId',
      'recoveryReservationId',
      'challengeId',
      'nonce',
      'expiresAt',
    ]);
    expect(encode(vector.fields).toString('hex')).toBe(vector.hex);
    expect(checkProof(vector.fields, vector.signature)).toBe(true);
  });
  it('rejects substitution of every bound field and noncanonical signatures', () => {
    for (let i = 0; i < vector.fields.length; i++) {
      const changed = [...vector.fields] as Transcript;
      if (i === 13) changed[13]++;
      else changed[i] = `${String(changed[i])}x` as never;
      expect(checkProof(changed, vector.signature), `field ${i}`).toBe(false);
    }
    expect(checkProof(vector.fields, vector.signature + '=')).toBe(false);
  });
  it.each(['initialize', 'commit', 'recover'])(
    'binds action %s with a real Ed25519 key',
    (action) => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const fields = [...vector.fields] as Transcript;
      fields[1] = action;
      fields[7] = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      expect(checkProof(fields, sign(null, encode(fields), privateKey).toString('base64url'))).toBe(
        true,
      );
    },
  );
});

function setup() {
  const cipher = createSealableSecretCipher();
  cipher.unlock('11'.repeat(32));
  return { cipher, model: new RecoveryModel(cipher) };
}
it('enforces contract lifetime, lost response retry and restart without extending expiry', () => {
  expect(Number.isSafeInteger(duration) && duration > 0).toBe(true);
  const { cipher, model } = setup();
  model.commit('op', 'device', 'synthetic-result', 1000, duration);
  const restarted = new RecoveryModel(cipher, structuredClone(model.rows));
  expect(restarted.recover('op', 'device', 1001)).toBe('synthetic-result');
  expect(restarted.recover('op', 'device', 1000 + duration - 1)).toBe('synthetic-result');
  expect(() => restarted.recover('op', 'device', 1000 + duration)).toThrow('rejected');
  expect(() => restarted.commit('op', 'device', 'another', 2000, duration)).toThrow('consumed');
});
it('checks identity before sealed-state disclosure and survives seal/unlock', () => {
  const { cipher, model } = setup();
  model.commit('op', 'device', 'synthetic-result', 0, duration);
  cipher.seal();
  expect(() => model.recover('op', 'other', 1)).toThrow('rejected');
  expect(() => model.recover('op', 'device', 1)).toThrow('locked');
  expect(() => model.commit('new', 'device', 'value', 1, duration)).toThrow('locked');
  expect(model.rows.has('new')).toBe(false);
  cipher.unlock('11'.repeat(32));
  expect(model.recover('op', 'device', 1)).toBe('synthetic-result');
});
it('rejects plaintext and swapped encrypted records', () => {
  const { model } = setup();
  model.commit('a', 'device', 'one', 0, duration);
  model.commit('b', 'device', 'two', 0, duration);
  model.rows.get('a')!.encrypted = model.rows.get('b')!.encrypted;
  expect(() => model.recover('a', 'device', 1)).toThrow('binding');
  model.rows.get('a')!.encrypted = 'plaintext';
  expect(() => model.recover('a', 'device', 1)).toThrow('plaintext');
});
it('acknowledgement and revocation erase only the recovery copy and retain consumption', () => {
  const { model } = setup();
  model.commit('a', 'device', 'one', 0, duration);
  expect(() => model.ack('a', 'device', 'wrong', 1)).toThrow();
  model.ack('a', 'device', 'one', 1);
  expect(model.rows.get('a')!.encrypted).toBeUndefined();
  expect(() => model.commit('a', 'device', 'again', 2, duration)).toThrow('consumed');
  model.commit('b', 'device', 'two', 0, duration);
  model.revoke('b');
  expect(() => model.recover('b', 'device', 1)).toThrow('rejected');
});
