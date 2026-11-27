import { brokeredSecretReferences } from './brokered-http-tool.js';

/**
 * Every secret reference a prompted call reads, for a standing-grant check that
 * has no gateway-supplied binding (ADR 0031). Undefined fails the check closed:
 * unreadable input, or a call that does not read the prompted alias.
 */
export function brokeredGrantReferences(
  toolName: 'verity_http_request' | 'verity_secret_run',
  request: Record<string, unknown> | undefined,
  secretAlias: string,
): readonly string[] | undefined {
  let references: readonly string[];
  try {
    references =
      toolName === 'verity_http_request'
        ? brokeredSecretReferences(toolName, request)
        : (request?.['secrets'] as { secretAlias: unknown }[]).map(({ secretAlias: alias }) => {
            if (typeof alias !== 'string') throw new Error('invalid secret alias');
            return alias;
          });
  } catch {
    return undefined;
  }
  return references.includes(secretAlias) ? references : undefined;
}
