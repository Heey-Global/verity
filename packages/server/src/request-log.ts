/** Never retain document capabilities or OAuth callback values in request logs. */
export function serializeServerRequest(request: {
  method: string;
  url: string;
  hostname?: string | undefined;
  ip?: string | undefined;
  socket?: { remotePort?: number | undefined } | undefined;
}) {
  const pathname = request.url.split('?', 1)[0] ?? '';
  return {
    method: request.method,
    url: ['/app/mcp/oauth/callback', '/mcp-app-document'].includes(pathname)
      ? pathname
      : request.url,
    hostname: request.hostname ?? '',
    remoteAddress: request.ip ?? '',
    remotePort: request.socket?.remotePort ?? 0,
  };
}
