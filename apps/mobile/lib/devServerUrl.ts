import type { DevServer } from '@verity/mobile';

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname === '[::]'
  );
}

function isWebUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** Resolve the URL a mobile device can use for a host-published Dev Server port. */
export function devServerUrl(baseUrl: string, server: DevServer): string | null {
  if (!server.hostPort) {
    if (!server.url) return null;
    try {
      const configured = new URL(server.url);
      return isWebUrl(configured) ? configured.toString() : null;
    } catch {
      return null;
    }
  }

  try {
    if (server.url) {
      const configured = new URL(server.url);
      if (!isWebUrl(configured)) return null;
      if (!isLoopback(configured.hostname)) return configured.toString();

      const verity = new URL(baseUrl);
      if (!isWebUrl(verity)) return null;
      configured.hostname = verity.hostname;
      configured.port = server.hostPort;
      return configured.toString();
    }

    const verity = new URL(baseUrl);
    if (!isWebUrl(verity)) return null;
    verity.protocol = 'http:';
    verity.port = server.hostPort;
    verity.pathname = '/';
    verity.search = '';
    verity.hash = '';
    return verity.toString();
  } catch {
    return null;
  }
}
