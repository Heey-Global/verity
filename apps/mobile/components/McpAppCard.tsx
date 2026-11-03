import { actionTitle } from '@verity/events';
import { appFallback, type McpAppCardEvent } from './McpAppCard.shared';
import { Card } from './ui/Card';
import { Text } from './ui/Text';

/** Native clients retain the ordinary tool result until native Apps hosting ships. */
export function McpAppCard({ event }: { event: McpAppCardEvent }) {
  return (
    <Card stacked>
      <Text>{actionTitle(event.toolName, event.title, event.source)}</Text>
      <Text>{appFallback(event) || 'Interactive app available in Verity web.'}</Text>
    </Card>
  );
}
