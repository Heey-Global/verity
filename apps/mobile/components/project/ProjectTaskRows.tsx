import { useEffect, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Task } from '@verity/mobile';

import { HandOffRow, type HandOffSession } from '../HandOffRow';
import { SwipeableSessionRow } from '../SessionRowActions';
import { Button, Sheet, Text, TextField } from '../ui';

/** Whether a screen reader is on: a swipe is out of its reach, so rows show their actions. */
export function useScreenReader(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (active) setEnabled(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setEnabled);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}

/** Open and done at a glance, above a project's own tasks. */
export function TaskSummary({ open, done }: { open: number; done: number }) {
  return (
    <View
      style={styles.summary}
      accessible
      accessibilityLabel={`${String(open)} open, ${String(done)} done`}
      testID="task-summary"
    >
      <View style={styles.summaryHead}>
        <Text variant="title">{`${String(open)} open`}</Text>
        <Text variant="subtitle">{`${String(done)} done`}</Text>
      </View>
      {open + done > 0 ? (
        <View style={styles.progress}>
          <View style={[styles.progressFill, { flex: done }]} />
          <View style={{ flex: open }} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One of the operator's tasks on a project's Tasks screen: a hand-over row that
 * swipes like a session row — right for Done, left for Edit and Delete — with
 * the same actions in the browser's context menu and, for a screen reader, as
 * buttons under the row.
 */
export function ProjectTaskRow({
  task,
  text,
  subtitle,
  session,
  busy,
  conflict,
  undo,
  screenReader,
  onHandOff,
  onOpenSession,
  onToggleDone,
  onEdit,
  onDelete,
  onResolveConflict,
}: {
  task: Task;
  /** The title, or the dictated text while no title could be made from it. */
  text: string;
  subtitle: string;
  session: HandOffSession | undefined;
  busy: boolean;
  /** The message of an edit that collided with another device's. */
  conflict: string | undefined;
  /** Just marked done: the row stays a moment to take it back. */
  undo: boolean;
  screenReader: boolean;
  onHandOff: (() => void) | undefined;
  onOpenSession: () => void;
  onToggleDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onResolveConflict: (keepMine: boolean) => void;
}) {
  const done = task.status === 'done';
  // The row's own answers (a conflict, an undo) come first; a screen reader
  // keeps Done, Edit and Delete beside them, since a swipe is out of its reach.
  const answers =
    conflict !== undefined || undo || screenReader ? (
      <>
        {conflict !== undefined ? (
          <>
            <Button
              label="Keep my edit"
              size="small"
              variant="secondary"
              disabled={busy}
              onPress={() => onResolveConflict(true)}
            />
            <Button
              label="Use server version"
              size="small"
              variant="secondary"
              disabled={busy}
              onPress={() => onResolveConflict(false)}
            />
          </>
        ) : null}
        {undo ? (
          <Button
            label="Undo"
            size="small"
            variant="secondary"
            disabled={busy}
            onPress={onToggleDone}
          />
        ) : null}
        {screenReader ? (
          <>
            {undo ? null : (
              <Button
                label={done ? 'Reopen' : 'Done'}
                size="small"
                variant="secondary"
                disabled={busy}
                onPress={onToggleDone}
              />
            )}
            <Button
              label="Edit"
              size="small"
              variant="secondary"
              disabled={busy}
              onPress={onEdit}
            />
            <Button
              label="Delete"
              size="small"
              variant="secondary"
              disabled={busy}
              onPress={onDelete}
            />
          </>
        ) : null}
      </>
    ) : undefined;
  return (
    <SwipeableSessionRow
      label={text}
      disabled={busy}
      leading={{
        label: done ? 'Reopen' : 'Done',
        menuLabel: done ? 'Reopen' : 'Mark as done',
        icon: done ? 'rotate-ccw' : 'check',
        onPress: onToggleDone,
      }}
      onEdit={onEdit}
      onDelete={onDelete}
    >
      <View testID={`project-task-${task.id}`} style={done ? styles.done : null}>
        <HandOffRow
          title={text}
          subtitle={conflict ?? subtitle}
          icon={done ? 'check-circle' : 'check-square'}
          session={done ? undefined : session}
          onOpenSession={onOpenSession}
          onPress={onEdit}
          accessibilityHint="Opens the task to edit it"
          onHandOff={done ? undefined : onHandOff}
          handOffLabel={`Let Verity start: ${text}`}
          busy={busy}
          answers={answers}
        />
      </View>
    </SwipeableSessionRow>
  );
}

/**
 * A task's text, description and attachments in a sheet: Edit from the row's
 * swipe or menu. Saving an unchanged or emptied text changes nothing.
 */
export function TaskEditSheet({
  task,
  text,
  onClose,
  onSave,
  onOpenAttachment,
}: {
  task: Task | null;
  /** What the row shows: the title, or the dictated text without a title. */
  text: string;
  onClose: () => void;
  onSave: (text: string) => Promise<unknown>;
  onOpenAttachment: (index: number) => void;
}) {
  const [value, setValue] = useState(text);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setValue(text);
  }, [task?.id, text]);
  const trimmed = value.trim();
  const save = () => {
    if (trimmed === '' || trimmed === text.trim()) {
      onClose();
      return;
    }
    setSaving(true);
    void onSave(trimmed)
      .then(onClose)
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };
  const describes = task?.detail && task.detail !== text ? task.detail : undefined;
  return (
    <Sheet
      visible={task !== null}
      title="Edit task"
      onClose={onClose}
      footer={
        <Button label="Save" fullWidth loading={saving} disabled={trimmed === ''} onPress={save} />
      }
    >
      <View style={styles.sheet}>
        <TextField
          label="Task"
          value={value}
          onChangeText={setValue}
          multiline
          lines={{ min: 2, max: 8 }}
          autoFocus
        />
        {describes !== undefined ? (
          <View style={styles.block}>
            <Text variant="label">Description</Text>
            <Text variant="bodySmall" selectable>
              {describes}
            </Text>
          </View>
        ) : null}
        {task !== null && task.attachments.length > 0 ? (
          <View style={styles.block}>
            <Text variant="label">Attachments</Text>
            {task.attachments.map((attachment, index) => (
              <View key={attachment.hash} style={styles.attachment}>
                <Button
                  label={attachment.filename}
                  icon="paperclip"
                  variant="text"
                  size="compact"
                  onPress={() => onOpenAttachment(index)}
                />
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: { gap: theme.spacing.sm, paddingTop: theme.spacing.md, paddingBottom: theme.spacing.sm },
  summaryHead: { flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm },
  progress: {
    flexDirection: 'row',
    height: 6,
    borderRadius: theme.radius.pill,
    overflow: 'hidden',
    backgroundColor: theme.colors.surfaceAlt,
  },
  progressFill: { backgroundColor: theme.colors.success },
  done: { opacity: 0.6 },
  sheet: { gap: theme.spacing.lg },
  block: { gap: theme.spacing.xs },
  attachment: { flexDirection: 'row' },
}));
