import { ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { spellOutBidiControls, type MatrixSendSummary } from '@verity/mobile';
import { Card } from './Card';
import { Text } from './Text';

/** Complete approved content, including the stable destination behind its display name. */
export function MatrixSendPreview({ summary }: { summary: MatrixSendSummary }) {
  return (
    <Card>
      <Text variant="subtitle" selectable>
        From: {spellOutBidiControls(summary.accountId)}
      </Text>
      <Text variant="subtitle" selectable>
        Homeserver: {spellOutBidiControls(summary.endpoint)}
      </Text>
      <Text variant="row" selectable>
        Room: {spellOutBidiControls(summary.roomName)}
      </Text>
      <Text variant="code" selectable>
        {spellOutBidiControls(summary.roomId)}
      </Text>
      <ScrollView style={styles.body} nestedScrollEnabled testID="matrix-send-body">
        <Text selectable>{spellOutBidiControls(summary.body)}</Text>
      </ScrollView>
      <Text variant="footnote">
        Approves this message only. Sent confirms Matrix acceptance; delivery through a bridge is
        separate.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({ body: { maxHeight: 240 } });
