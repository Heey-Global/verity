/** Expected loss of upstream OAuth authority, distinct from transport failures. */
export class McpOAuthAuthorizationRequired extends Error {
  constructor() {
    super('MCP OAuth connection is not authorized. Reconnect OAuth.');
    this.name = 'McpOAuthAuthorizationRequired';
  }
}

export type McpOAuthDiscoveryStage =
  | 'invalid_url'
  | 'dns_failed'
  | 'address_refused'
  | 'connect_failed'
  | 'tls_failed'
  | 'timeout'
  | 'redirect'
  | 'metadata_missing'
  | 'metadata_status'
  | 'metadata_invalid'
  | 'resource_mismatch'
  | 'issuer_mismatch'
  | 'pkce_unsupported'
  | 'grant_unsupported'
  | 'registration_failed';

/** What the server log may record about a failed step. Never response bodies or credentials. */
export interface McpOAuthDiscoveryDetail {
  host?: string;
  address?: string;
  range?: string;
  path?: string;
  status?: number;
}

/**
 * A failed OAuth discovery or registration step. The message is written by
 * Verity from the step, host, URL and status so the form can say what to fix;
 * it never carries a response body.
 */
export class McpOAuthDiscoveryError extends Error {
  constructor(
    readonly code: McpOAuthDiscoveryStage,
    message: string,
    readonly detail: McpOAuthDiscoveryDetail = {},
  ) {
    super(message);
    this.name = 'McpOAuthDiscoveryError';
  }
}
