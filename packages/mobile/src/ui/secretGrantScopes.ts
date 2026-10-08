export type StandingSecretGrantScope = 'session' | 'project' | 'forever';

/** Reusable scopes for brokered secret approvals. Permanent grants are unavailable. */
export function secretGrantScopes(
  toolName: string,
  input?: Record<string, unknown>,
): readonly StandingSecretGrantScope[] {
  void input;
  return toolName === 'verity_secret_run' || toolName === 'verity_http_request'
    ? ['session', 'project']
    : [];
}
