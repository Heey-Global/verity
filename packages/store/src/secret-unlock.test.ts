import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SealedError,
  createSealableSecretCipher,
  createSecretCipher,
  isEncrypted,
} from './crypto.js';
import { migrateToLatest } from './db.js';
import {
  createKeyVerifier,
  deriveKeyFromPassword,
  generateSalt,
  keyMatchesVerifier,
} from './secret-key.js';
import { EventStore } from './store.js';
import { createRawDb, truncateAll, type RawTestDb } from './testing.js';

const RAW_KEY = Buffer.alloc(32, 0x11).toString('hex');

describe('createSealableSecretCipher', () => {
  it('is sealed by default: encrypt throws, enveloped decrypt throws, plaintext passes', () => {
    const c = createSealableSecretCipher();
    expect(c.isSealed()).toBe(true);
    expect(() => c.encrypt('secret')).toThrow(SealedError);
    // A value that IS enveloped can't be decrypted while sealed...
    const enveloped = createSecretCipher(RAW_KEY).encrypt('secret');
    expect(() => c.decrypt(enveloped)).toThrow(SealedError);
    // ...but a plaintext (non-secret) value still passes through.
    expect(c.decrypt('plaintext-non-secret')).toBe('plaintext-non-secret');
  });

  it('encrypts/decrypts once unlocked and re-seals on seal()', () => {
    const c = createSealableSecretCipher();
    c.unlock(RAW_KEY);
    expect(c.isSealed()).toBe(false);
    const stored = c.encrypt('secret');
    expect(isEncrypted(stored)).toBe(true);
    expect(c.decrypt(stored)).toBe('secret');

    c.seal();
    expect(c.isSealed()).toBe(true);
    expect(() => c.decrypt(stored)).toThrow(SealedError);
  });
});

describe('master-password key derivation', () => {
  it('derives a stable 32-byte key for the same password + salt', () => {
    const salt = generateSalt();
    const a = deriveKeyFromPassword('correct horse battery staple', salt);
    const b = deriveKeyFromPassword('correct horse battery staple', salt);
    expect(a).toBe(b);
    expect(Buffer.from(a, 'hex').length).toBe(32);
  });

  it('derives different keys for a different salt or password', () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    expect(deriveKeyFromPassword('pw', salt1)).not.toBe(deriveKeyFromPassword('pw', salt2));
    expect(deriveKeyFromPassword('pw-a', salt1)).not.toBe(deriveKeyFromPassword('pw-b', salt1));
  });

  it('verifier accepts the right password and rejects the wrong one', () => {
    const salt = generateSalt();
    const key = deriveKeyFromPassword('right-password', salt);
    const verifier = createKeyVerifier(key);

    expect(keyMatchesVerifier(key, verifier)).toBe(true);
    const wrong = deriveKeyFromPassword('wrong-password', salt);
    expect(keyMatchesVerifier(wrong, verifier)).toBe(false);
  });
});

describe('EventStore — secret_key_meta + sealed behaviour', () => {
  let raw: RawTestDb;

  beforeAll(async () => {
    raw = createRawDb();
    await migrateToLatest(raw.db);
  });
  afterAll(async () => {
    await raw.close();
  });
  beforeEach(async () => {
    await truncateAll(raw.db);
  });

  it('round-trips the key-derivation metadata (readable while sealed)', async () => {
    // A SEALED store still reads/writes the meta (no encrypted column touched).
    const sealed = createSealableSecretCipher();
    const store = new EventStore(raw.db, sealed);
    expect(await store.getSecretKeyMeta()).toBeUndefined();

    await store.setSecretKeyMeta({ salt: 'salt-b64', verifier: 'enc:v1:verifier' });
    expect(await store.getSecretKeyMeta()).toEqual({
      salt: 'salt-b64',
      verifier: 'enc:v1:verifier',
    });

    // idempotent upsert
    await store.setSecretKeyMeta({ salt: 'salt-2', verifier: 'enc:v1:verifier-2' });
    expect(await store.getSecretKeyMeta()).toEqual({
      salt: 'salt-2',
      verifier: 'enc:v1:verifier-2',
    });
  });

  it('blocks writing a secret while sealed, but allows non-secret settings', async () => {
    const sealed = createSealableSecretCipher();
    const store = new EventStore(raw.db, sealed);

    // Non-secret-only update works while sealed.
    await expect(store.updateVeritySettings({ gitUserName: 'h-teske' })).resolves.toMatchObject({
      gitUserName: 'h-teske',
    });

    // Writing an actual secret while sealed fails closed.
    await expect(store.updateVeritySettings({ gitSshPrivateKey: 'secret' })).rejects.toThrow(
      SealedError,
    );
  });

  it('cannot read a stored secret after re-sealing, can again after unlock', async () => {
    const cipher = createSealableSecretCipher();
    cipher.unlock(RAW_KEY);
    const store = new EventStore(raw.db, cipher);

    await store.updateVeritySettings({ gitSshPrivateKey: 'my-key', gitUserName: 'h-teske' });

    cipher.seal();
    // getVeritySettings decrypts the secret column → throws while sealed.
    await expect(store.getVeritySettings()).rejects.toThrow(SealedError);

    cipher.unlock(RAW_KEY);
    await expect(store.getVeritySettings()).resolves.toMatchObject({
      gitSshPrivateKey: 'my-key',
      gitUserName: 'h-teske',
    });
  });

  it('getVeritySettingsRaw reads settings while sealed without decrypting', async () => {
    const cipher = createSealableSecretCipher();
    cipher.unlock(RAW_KEY);
    const store = new EventStore(raw.db, cipher);
    await store.updateVeritySettings({ gitSshPrivateKey: 'my-key', gitUserName: 'h-teske' });

    cipher.seal();
    // Raw read does NOT throw while sealed; the secret column holds the stored
    // (encrypted) form, non-secret fields are intact.
    const rawRec = await store.getVeritySettingsRaw();
    expect(rawRec?.gitUserName).toBe('h-teske');
    expect(rawRec?.gitSshPrivateKey?.startsWith('enc:v1:')).toBe(true);
    expect(rawRec?.gitSshPrivateKey).not.toBe('my-key');
  });

  it('insertSecretKeyMetaIfAbsent inserts once then refuses (first writer wins)', async () => {
    const store = new EventStore(raw.db, createSealableSecretCipher());
    expect(await store.insertSecretKeyMetaIfAbsent({ salt: 's1', verifier: 'v1' })).toBe(true);
    expect(await store.insertSecretKeyMetaIfAbsent({ salt: 's2', verifier: 'v2' })).toBe(false);
    expect(await store.getSecretKeyMeta()).toEqual({ salt: 's1', verifier: 'v1' });
  });
});
