import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, CardHead, Text } from '../../components/ui';
import { BeforeAfter, ignore, Session, UserMessage, VerityMessage } from './parts';

/**
 * An agent finished a task with a lasting finding and asks once, at the end of
 * its answer. Left open, the card moves to the Wiki's To review.
 */
export default function ChatCardMockup() {
  return (
    <Session>
      <UserMessage>The session list crashes after deleting a session. Can you fix it?</UserMessage>
      <VerityMessage>
        <Text variant="body">
          Fixed and pushed. The crash came from a gesture handler that still held the deleted row;
          the list now releases it before removing the row.
        </Text>
        <Card stacked>
          <CardHead title="Add to the Wiki?" subtitle="Mobile reliability · new finding" />
          <BeforeAfter after="Deleting a row must release its gesture handler first; otherwise the list crashes on iOS." />
          <View style={styles.actions}>
            <Button label="Discard" variant="secondary" size="compact" onPress={ignore} />
            <Button label="Add" size="compact" onPress={ignore} />
          </View>
        </Card>
      </VerityMessage>
    </Session>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm },
}));
