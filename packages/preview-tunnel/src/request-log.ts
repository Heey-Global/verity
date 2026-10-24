export interface PreviewRequestLog {
  event: 'request.completed';
  shareId: string;
  method: string;
  pathClass: 'root' | 'content' | 'internal';
  status: number | null;
  outcome: 'completed' | 'aborted';
  durationMs: number;
  tunnelState: 'connected' | 'disconnected';
  connectionGeneration: number;
  tunnelUnavailable: boolean;
}

/** Fixed classes avoid leaking tokens embedded in either paths or queries. */
export function requestPathClass(path: string): PreviewRequestLog['pathClass'] {
  const pathname = path.split('?', 1)[0];
  if (pathname === '/') return 'root';
  return pathname === '/__verity' || pathname?.startsWith('/__verity/') ? 'internal' : 'content';
}

export function requestMethod(method: string): string {
  return /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) ? method : 'OTHER';
}
