import { SettingsChoiceRow } from '../../components/settings/SettingsChrome';
import { Button, Group, Sheet, Text } from '../../components/ui';
import { Body, DiagnosticsScreen, Fill, ignore } from './parts';

/**
 * Detail mode before it starts: pick how long it runs. It switches itself off
 * when the time is up, so a forgotten switch cannot keep the extra load.
 */
export default function DetailModeMockup() {
  return (
    <Fill>
      <DiagnosticsScreen detailActive={false} />
      <Sheet
        visible
        title="Detail mode"
        onClose={ignore}
        footer={<Button label="Start for 1 hour" onPress={ignore} fullWidth />}
      >
        <Body>
          <Text variant="bodySmall" tone="muted">
            Records more per request while you look for a problem. It turns itself off when the time
            is up.
          </Text>
          <Group>
            <SettingsChoiceRow title="15 minutes" selected={false} onPress={ignore} />
            <SettingsChoiceRow title="1 hour" selected onPress={ignore} />
            <SettingsChoiceRow title="4 hours" selected={false} onPress={ignore} />
          </Group>
          <Text variant="subtitle">Recorded additionally</Text>
          <Text variant="bodySmall">
            Database query patterns per request, each external call with its cause, and detailed
            timings of slow requests.
          </Text>
          <Text variant="subtitle">Never recorded</Text>
          <Text variant="bodySmall" tone="muted">
            Messages, transcripts, file contents, secrets and query values.
          </Text>
          <Text variant="footnote">Adds a few percent of server load while it runs.</Text>
        </Body>
      </Sheet>
    </Fill>
  );
}
