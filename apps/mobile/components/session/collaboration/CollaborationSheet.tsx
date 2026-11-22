import type { CollaborationEntry } from '@verity/mobile';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../../Icon';
import { Group, Row, SectionHeader, Sheet, StatusTag, Text } from '../../ui';
import { CollaborationTile } from './CollaborationTile';
import { DIRECTION, peerTitle, rowEntries, shortAge, STATE_LABEL } from './model';

const INTENT = {
  waitingForYou: 'needsSetup',
  working: 'transient',
  answer: 'action',
  done: 'ready',
} as const;

function EntryRow({
  entry,
  now,
  onOpen,
}: {
  entry: CollaborationEntry;
  now: number;
  onOpen: (entry: CollaborationEntry) => void;
}) {
  const { theme } = useUnistyles();
  const direction = DIRECTION[entry.direction];
  return (
    <Row
      title={peerTitle(entry)}
      subtitle={`${entry.projectName} · ${direction.label} · ${shortAge(entry.updatedAt, now)}`}
      leading={{
        element: (
          <View>
            <CollaborationTile projectName={entry.projectName} state={entry.state} size={32} />
            <View style={styles.direction}>
              <Icon name={direction.icon} size={11} color={theme.colors.textMuted} />
            </View>
          </View>
        ),
      }}
      trailing={<StatusTag intent={INTENT[entry.state]} label={STATE_LABEL[entry.state]} tag />}
      onPress={() => onOpen(entry)}
      navigates
      settled={entry.state === 'done'}
    />
  );
}

/** The list behind the row: current collaborations first, finished ones under Earlier. */
export function CollaborationSheet({
  visible,
  entries,
  now = Date.now(),
  onOpen,
  onClose,
}: {
  visible: boolean;
  entries: readonly CollaborationEntry[];
  now?: number;
  onOpen: (entry: CollaborationEntry) => void;
  onClose: () => void;
}) {
  const current = rowEntries(entries);
  const earlier = entries.filter((entry) => entry.section === 'earlier');
  return (
    <Sheet visible={visible} title="Collaboration" onClose={onClose}>
      <View style={styles.body}>
        {current.length > 0 ? (
          <Group>
            {current.map((entry) => (
              <EntryRow key={entry.sessionId} entry={entry} now={now} onOpen={onOpen} />
            ))}
          </Group>
        ) : null}
        {earlier.length > 0 ? (
          <>
            <SectionHeader title="Earlier" />
            <Group>
              {earlier.map((entry) => (
                <EntryRow key={entry.sessionId} entry={entry} now={now} onOpen={onOpen} />
              ))}
            </Group>
          </>
        ) : null}
        <Text variant="footnote" tone="muted" style={styles.note}>
          Sessions appear here when Verity asks, joins or starts them. They can only exchange
          messages; nothing else is shared.
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing.sm, paddingBottom: theme.spacing.lg },
  note: { paddingHorizontal: theme.spacing.sm, paddingTop: theme.spacing.xs },
  direction: {
    position: 'absolute',
    right: -4,
    bottom: -3,
    width: 16,
    height: 16,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
}));
