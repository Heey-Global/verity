import type { AgentEvent } from '@verity/events';
export type McpAppCardEvent = Extract<AgentEvent, { t: 'mcp_app' }>;

export function appFallback(event: McpAppCardEvent): string {
  const content = event.result.content;
  return Array.isArray(content)
    ? content
        .flatMap((entry: unknown) => {
          if (
            typeof entry !== 'object' ||
            entry === null ||
            !('type' in entry) ||
            entry.type !== 'text' ||
            !('text' in entry) ||
            typeof entry.text !== 'string'
          )
            return [];
          return [entry.text];
        })
        .join('\n')
        .slice(0, 4000)
    : '';
}
