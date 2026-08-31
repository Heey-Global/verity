import type { Href } from 'expo-router';

/** Accept only an app-internal absolute path. Protocol-relative URLs, encoded or
 * literal backslashes, and control characters are rejected before Expo Router
 * sees them. */
export function safeReturnTo(
  value: string | string[] | undefined,
  fallback: Href | null,
): Href | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  let decoded: string | undefined;
  try {
    decoded = candidate;
    for (let pass = 0; decoded !== undefined && pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return fallback;
  }
  if (
    candidate === undefined ||
    decoded === undefined ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    /%(?:25|2f|5c)/i.test(candidate) ||
    decoded.includes('\\') ||
    decoded.startsWith('//') ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return fallback;
  }
  return candidate as Href;
}
