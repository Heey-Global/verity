import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';

export const CONNECTOR_PROTOCOL_VERSION: number;
export const CONNECTOR_HOST: string;

export interface EgressConnectorOptions {
  port: number | string;
  localAuthority: string;
  egressUrl: string;
  egressAuthority: string;
  codexEgressUrl?: string;
  codexEgressAuthority?: string;
  ca: string | Buffer;
  cert: string | Buffer;
  key: string | Buffer;
  servername?: string;
  shutdownGraceMs?: number;
  forward?: (request: {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body: IncomingMessage;
    signal: AbortSignal;
    tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer; servername: string };
  }) => Promise<{ status: number; headers: IncomingHttpHeaders; body: Readable }>;
}

export function validateEgressConnectorOptions(options: EgressConnectorOptions): {
  port: number;
  egressUrl: URL;
  codexEgressUrl?: URL;
};
export function createEgressConnectorHandler(
  options: EgressConnectorOptions,
): import('node:http').RequestListener;
export function closeServerBounded(
  server: { close(callback: (error?: Error) => void): unknown; closeAllConnections(): void },
  graceMs: number,
): Promise<void>;
export function runEgressConnector(options: EgressConnectorOptions): Promise<{
  host: string;
  port: number;
  close(): Promise<void>;
}>;
