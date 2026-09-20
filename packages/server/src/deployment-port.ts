/** Parse a port from an env string, defaulting when unset. Rejects non-integer /
 * out-of-range values loudly — otherwise `Number('foo')` → NaN → Node coerces
 * the port to 0 and silently binds a random ephemeral port (unreachable server). */
export function parsePort(value: string | undefined, fallback = 8787): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT "${value}": expected an integer in 0-65535`);
  }
  return port;
}
