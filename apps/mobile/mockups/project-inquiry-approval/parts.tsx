import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button, Card, CardHead, StatusTag, Text } from '../../components/ui';

export const ignore = () => undefined;

/** Who asks: the asking project and session, shown on every copy of the card. */
export interface InquiryOrigin {
  project: string;
  session: string;
  /** The card sits in the asking session itself. */
  here?: boolean;
}

/**
 * A request from a session in another project, waiting for the user. The title
 * names both projects and the subtitle the asking session, so the card says who
 * asks whom before what. Nothing reaches the target project, not even a
 * session, before one of the allow buttons. "Always allow" is offered for
 * questions only; a change is approved one request at a time.
 */
export function InquiryApprovalCard({
  kind = 'question',
  from,
  target = 'Deep-OCR',
}: {
  kind?: 'question' | 'change';
  from: InquiryOrigin;
  target?: string;
}) {
  const question = kind === 'question';
  const origin = from.here ? 'From this session' : `From session „${from.session}“`;
  return (
    <Card stacked>
      <CardHead
        title={`${from.project} → ${target}`}
        subtitle={`${origin} · ${question ? 'read-only' : 'may change code'}`}
        trailing={<StatusTag intent="needsSetup" label={question ? 'Question' : 'Change'} />}
      />
      <View style={styles.quote}>
        <Text variant="bodySmall">
          {question
            ? 'Sind die Dokumente jetzt vom Backup ausgeschlossen, und ist das frühere Problem gelöst?'
            : 'Bitte den Ordner für Dokumente vom Backup ausschließen.'}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button label="Allow once" size="small" onPress={ignore} />
        {question ? (
          <Button label="Always allow" size="small" variant="secondary" onPress={ignore} />
        ) : null}
        <Button label="Reject" size="small" variant="text" onPress={ignore} />
      </View>
    </Card>
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
