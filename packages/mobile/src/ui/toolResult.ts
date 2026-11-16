/** The JSON object a Verity tool answered with: MCP wraps it as text content,
 *  sometimes nested or as structured content. An error result reads as absent,
 *  so a card never renders state the tool did not confirm. */
export function unwrapToolResult(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) return unwrapToolResult({ content: value }, depth + 1);
  const v = value as Record<string, unknown>;
  if (v.isError === true) return undefined;
  if (v.structuredContent) return unwrapToolResult(v.structuredContent, depth + 1);
  if (Array.isArray(v.content))
    for (const item of v.content as unknown[]) {
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
        try {
          return unwrapToolResult(JSON.parse(item.text), depth + 1);
        } catch {
          /* Not a JSON result. */
        }
      }
    }
  return v;
}
