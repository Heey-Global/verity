export type StandingSecretGrantScope = 'session' | 'project' | 'forever';

/**
 * Standing grant scopes the approval card may offer for `toolName`.
 *
 * ACP is the only transport, and it never allows permanent grants (ADR 0014 D3).
 */
export function secretGrantScopes(
  toolName: string,
  input?: Record<string, unknown>,
): readonly StandingSecretGrantScope[] {
  if (toolName === 'verity_secret_run') {
    const command = input?.['command'];
    const entry = input?.['entryScript'];
    if (
      !Array.isArray(command) ||
      command.length < 2 ||
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry)
    )
      return [];
    const path = (entry as Record<string, unknown>)['path'];
    const projectPath = (entry as Record<string, unknown>)['projectPath'];
    const sha256 = (entry as Record<string, unknown>)['sha256'];
    const loading = (entry as Record<string, unknown>)['loading'];
    // Reusable approval is intentionally narrow: the transparent, hash-bound
    // file must be the interpreter's direct entry operand. Eval/stdin/module and
    // option-driven dynamic loading return to the one-time button.
    if (
      typeof path !== 'string' ||
      typeof projectPath !== 'string' ||
      projectPath
        .split('/')
        .some((component) => component === '' || component === '.' || component === '..') ||
      command[1] !== path ||
      typeof command[0] !== 'string' ||
      (!command[0].startsWith('/bin/') && !command[0].startsWith('/usr/')) ||
      loading !== 'isolated' ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    )
      return [];
    return ['session', 'project'];
  }
  if (toolName !== 'verity_http_request') return [];
  return ['session', 'project'];
}
