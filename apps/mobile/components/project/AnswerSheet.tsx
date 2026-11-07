import type { InboxAction, InboxItem } from '@verity/mobile';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { Button, Group, Row, Sheet, Text } from '../ui';

/** The longest answer a row still shows as its own button. */
export const SHORT_ANSWER = 24;
/** The most answers a row still shows as buttons. */
export const INLINE_ANSWERS = 3;

/**
 * Whether a row's answers fit under it as small buttons. Otherwise the row
 * shows one button that opens {@link AnswerSheet}: a sentence-long answer, cut
 * or wrapped into a pill, is not something to decide from. All answers go
 * together, so a row is never half inline and half in a sheet.
 */
export function answersFitInline(answers: readonly InboxAction[]): boolean {
  return (
    answers.length <= INLINE_ANSWERS &&
    answers.every((action) => action.label.length <= SHORT_ANSWER)
  );
}

/** Names one answer so every overview shows progress on the same button. */
export function answerId(action: InboxAction): string {
  return `${action.kind}:${action.label}`;
}

/** Shared quiet answers for Home cards and project rows. */
export function AnswerButtons({
  answers,
  pending,
  disabled,
  onAnswer,
  onMore,
}: {
  answers: readonly InboxAction[];
  pending: string | false;
  disabled: boolean;
  onAnswer: (action: InboxAction) => void;
  onMore: () => void;
}) {
  if (answers.length === 0) return null;
  if (!answersFitInline(answers))
    return (
      <Button
        label={`${String(answers.length)} answers`}
        icon="chevron-down"
        size="small"
        variant="secondary"
        loading={pending !== false}
        disabled={disabled}
        onPress={onMore}
      />
    );
  return answers.map((action) => (
    <Button
      key={answerId(action)}
      label={action.label}
      size="small"
      variant="secondary"
      loading={pending === answerId(action)}
      disabled={disabled}
      onPress={() => onAnswer(action)}
    />
  ));
}

/**
 * A row's answers in full, one per line, under the question they answer.
 * Choosing one closes the sheet and sends it; the row shows the progress.
 */
export function AnswerSheet({
  item,
  answers,
  onAnswer,
  onOpenSession,
  onClose,
}: {
  item: InboxItem | null;
  answers: readonly InboxAction[];
  onAnswer: (action: InboxAction) => void;
  /** Leaves the answer to the operator's own words in the session. */
  onOpenSession?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Sheet
      visible={item !== null}
      // `||`: an empty message would leave the sheet without its question.
      title={item?.message || item?.title || ''}
      onClose={onClose}
      footer={
        onOpenSession !== undefined ? (
          <Button label="Open session" variant="text" onPress={onOpenSession} />
        ) : undefined
      }
    >
      {item !== null ? (
        <Text variant="subtitle" tone="muted" style={styles.context}>
          {item.context}
        </Text>
      ) : null}
      <Group>
        {answers.map((action) => (
          <Row
            key={`${action.kind}:${action.label}`}
            title={action.label}
            wrap
            trailing={<Icon name="arrow-right" size={16} color={theme.colors.textFaint} />}
            onPress={() => onAnswer(action)}
            accessibilityHint="Sends this answer."
          />
        ))}
      </Group>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  context: { marginBottom: theme.spacing.md },
}));
