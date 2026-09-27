/** The connector must dial the TLS listener whose certificate the mobile app has pinned. */
export function remoteControlIngressForTls(
  tlsMode: 'direct' | 'backend',
  directTlsEnabled: boolean,
  port: number,
): { localHost: string; localPort: number } | undefined {
  if (tlsMode === 'backend') {
    return { localHost: 'verity', localPort: 8082 };
  }
  if (!directTlsEnabled) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('remote control requires a fixed TLS port');
  }
  return { localHost: '127.0.0.1', localPort: port };
}
