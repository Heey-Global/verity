/** How long an unanswered card may hold one call open before the caller is denied. Long
 *  enough that an operator who stepped away can still answer, short enough that an
 *  abandoned request does not pin a connection for the session's life. */
export const MCP_GATEWAY_APPROVAL_TIMEOUT_MS = 5 * 60_000;
