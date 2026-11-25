import { Button, Group, Row, Sheet, Text } from '../../components/ui';
import { Body, DiagnosticsScreen, Fill, SAMPLE, ignore, value } from './parts';

/** Detail mode while it runs: time left, who started it, and a way to stop now. */
export default function DetailModeActiveMockup() {
  return (
    <Fill>
      <DiagnosticsScreen detailActive />
      <Sheet
        visible
        title="Detail mode"
        onClose={ignore}
        footer={<Button label="Stop detail mode" variant="secondary" onPress={ignore} fullWidth />}
      >
        <Body>
          <Group>
            <Row title="Running until" trailing={value(SAMPLE.detailUntil)} />
            <Row title="Time left" trailing={value(SAMPLE.detailMinutes)} />
            <Row title="Started by" trailing={value('Verity Control')} />
          </Group>
          <Text variant="bodySmall" tone="muted">
            The next diagnostic report includes the detailed breakdown from this period.
          </Text>
        </Body>
      </Sheet>
    </Fill>
  );
}
