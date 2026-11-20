/**
 * Mirrors the server's rule for the connection name. The name is the MCP server
 * key agents see (tool names read `mcp__<name>__<tool>`), not a display label, so
 * it only takes identifier characters. Explaining that here saves a round trip
 * that would end in a rejected request.
 */
export function connectionNameProblem(value: string): string | undefined {
  const name = value.trim();
  if (name === '') return undefined;
  if (name.length > 80) return 'Use at most 80 characters.';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name))
    return `Use only letters, digits, hyphens and underscores, starting with a letter or digit — for example ${suggestedConnectionName(name)}.`;
  if (name.toLowerCase() === 'verity') return 'The name verity is reserved.';
  return undefined;
}

function suggestedConnectionName(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[-_]+|-+$/gu, '')
    .slice(0, 80);
  return slug === '' || slug === 'verity' ? 'my-tools' : slug;
}
