import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, CardHead, StatusTag, Text } from '../../components/ui';
import { ignore, Line, NOW, SessionWithLine, UserMessage } from './parts';

/**
 * A handover waits for the user: the line turns to the attention tone and a
 * tap scrolls to the approval card. The target session is not reached before.
 */
export default function ApprovalMockup() {
  return (
    <SessionWithLine
      line={
        <Line
          entries={[
            {
              sessionId: 'docs-new',
              sessionName: 'New session',
              projectId: 'docs',
              projectName: 'Docs',
              direction: 'handedOver',
              state: 'waitingForYou',
              updatedAt: new Date(NOW).toISOString(),
              section: 'current',
            },
          ]}
        />
      }
    >
      <UserMessage>Have the docs team write an ADR about this.</UserMessage>
      <Text variant="body">I will start a new session in the Docs project for that.</Text>
      <Card stacked>
        <CardHead
          title="Verity → Docs"
          subtitle="New session · task handover"
          trailing={<StatusTag intent="needsSetup" label="Handover" />}
        />
        <View style={styles.quote}>
          <Text variant="bodySmall">
            Write an ADR: collaboration between sessions appears automatically in the header.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button label="Allow" size="small" onPress={ignore} />
          <Button label="Reject" size="small" variant="text" onPress={ignore} />
        </View>
      </Card>
    </SessionWithLine>
  );
}

const styles = StyleSheet.create((theme) => ({
  quote: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
}));
