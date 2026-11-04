// Discarding an unfinished diagnostic test may skip its Stop check only on a
// device that has no native tunnel at all. That decision rests on this code,
// not on the wording of the user-facing message.
const UNSUPPORTED = 'NATIVE_TUNNEL_UNSUPPORTED';

export function nativeTunnelUnsupported() {
  return Object.assign(new Error('Native connection test unsupported.'), { code: UNSUPPORTED });
}

export function isNativeTunnelUnsupported(error: unknown) {
  return (
    error instanceof Error && 'code' in error && (error as { code?: unknown }).code === UNSUPPORTED
  );
}
