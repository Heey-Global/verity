/** Remote admission is an explicit deployment opt-in. The connector must dial
 * the TLS listener whose certificate the mobile app has pinned. */
export function remoteControlIngressFromEnv(
  enabled: string | undefined,
  tlsMode: 'direct' | 'backend',
  directTlsEnabled: boolean,
  port: number,
): { localHost: string; localPort: number } | undefined {
  if (enabled === undefined || enabled === '0') return undefined;
  if (enabled !== '1') throw new Error('VERITY_REMOTE_CONTROL_ENABLED must be 0 or 1');
  if (tlsMode === 'backend') {
    return { localHost: 'verity', localPort: 8082 };
  }
  if (!directTlsEnabled) throw new Error('remote control requires a TLS listener');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('remote control requires a fixed TLS port');
  }
  return { localHost: '127.0.0.1', localPort: port };
}
