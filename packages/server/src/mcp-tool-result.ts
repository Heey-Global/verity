const richMcpToolResultMarker = Symbol('verity.rich-mcp-tool-result');

export interface RichMcpToolResult {
  readonly [richMcpToolResultMarker]: true;
  readonly content: readonly unknown[];
}

export function richMcpToolResult(content: readonly unknown[]): RichMcpToolResult {
  return { [richMcpToolResultMarker]: true, content };
}

export function isRichMcpToolResult(value: unknown): value is RichMcpToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    richMcpToolResultMarker in value &&
    value[richMcpToolResultMarker] === true &&
    Array.isArray((value as { content?: unknown }).content)
  );
}
