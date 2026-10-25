/** Platforms without Web Crypto supply their native SHA-256 implementation. */
export type RecordingDigest = (text: string) => Promise<string>;

export const recordingDigest: RecordingDigest = async (text) => {
  if (!globalThis.crypto?.subtle) throw new Error('Recording hash verification unavailable');
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
