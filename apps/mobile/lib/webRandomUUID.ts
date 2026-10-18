// `crypto.randomUUID` exists only in secure contexts (https and localhost). The
// web build served over plain http on a local network, as the Expo dev server's
// LAN address is, has `crypto` without it, and expo-crypto's `randomUUID` then
// throws before the first screen renders. `getRandomValues` is available in every
// context, so derive a version 4 UUID from it (RFC 4122 section 4.4) where the
// native one is missing. Secure contexts keep the browser's implementation.

type UUID = `${string}-${string}-${string}-${string}-${string}`;

/** Adds `randomUUID` to `crypto` when it lacks one; returns whether it did. */
export function installRandomUUID(crypto: Partial<Crypto> | undefined): boolean {
  if (!crypto || typeof crypto.randomUUID === 'function') return false;
  if (typeof crypto.getRandomValues !== 'function') return false;
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  crypto.randomUUID = (): UUID => {
    const bytes = getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  return true;
}

installRandomUUID(globalThis.crypto);
