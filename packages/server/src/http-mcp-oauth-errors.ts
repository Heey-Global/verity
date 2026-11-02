/** Expected loss of upstream OAuth authority, distinct from transport failures. */
export class McpOAuthAuthorizationRequired extends Error {
  constructor() {
    super('MCP OAuth connection is not authorized. Reconnect OAuth.');
    this.name = 'McpOAuthAuthorizationRequired';
  }
}
