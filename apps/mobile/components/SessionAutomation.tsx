// The operator-facing surfaces of a session automation: the bar under the
// session header, its detail sheet, and the card that turns an agent's proposal
// into an automation. Deliberately non-technical: no run ids, exit codes, or
// script output, only what runs, when, and how the last run went.
import type { AutomationProposalMessage, SessionAutomation } from '@verity/mobile';
import { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
  automationLastRunText,
  automationNextRunText,
  automationScheduleLabel,
} from '../lib/automationText';
import { Icon } from './Icon';

/** One line under the session header, styled like the connected-service bars. */
export function AutomationBar({
  automation,
  onOpen,
  onDelete,
}: {
  automation: SessionAutomation;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { theme } = useUnistyles();
  const paused = automation.status === 'paused';
  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.barMain}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Show automation ${automation.name}`}
      >
        <Icon
          name="repeat"
          size={16}
          color={paused ? theme.colors.textMuted : theme.colors.primary}
        />
        <Text style={styles.barText} numberOfLines={1}>
          {automation.name} ·{' '}
          <Text style={styles.barSchedule}>
            {paused ? 'Paused' : automationScheduleLabel(automation.schedule)}
          </Text>
        </Text>
      </Pressable>
      <Pressable
        onPress={onDelete}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Delete automation"
      >
        <Icon name="x" size={16} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}

/** Plain-language details plus pause/resume and delete. */
export function AutomationSheet({
  automation,
  updating,
  onToggle,
  onDelete,
  onClose,
}: {
  automation: SessionAutomation;
  updating: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { theme } = useUnistyles();
  const paused = automation.status === 'paused';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close automation"
      />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetEyebrow}>Automation</Text>
        <Text style={styles.sheetTitle}>{automation.name}</Text>
        <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
          <Section label="When">
            <Text style={styles.sectionText}>{automationScheduleLabel(automation.schedule)}</Text>
            <Text style={styles.sectionHint}>{automationNextRunText(automation)}</Text>
          </Section>
          <Section label="What the agent does">
            <Text style={styles.sectionText}>{automation.prompt}</Text>
            {automation.script !== null ? (
              <Text style={styles.sectionHint}>
                A quick check runs first, and the agent only starts when there is something to do.
              </Text>
            ) : null}
          </Section>
          <Section label="Last run">
            <Text style={styles.sectionText}>{automationLastRunText(automation)}</Text>
          </Section>
          <Text style={styles.sectionHint}>
            To change it, describe the change in this chat and confirm the new version.
          </Text>
        </ScrollView>
        <View style={styles.sheetActions}>
          <Pressable
            onPress={onToggle}
            disabled={updating}
            accessibilityRole="button"
            accessibilityLabel={paused ? 'Resume automation' : 'Pause automation'}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed ? styles.pressed : null,
              updating ? styles.disabled : null,
            ]}
          >
            {updating ? <ActivityIndicator size="small" color={theme.colors.text} /> : null}
            <Icon name={paused ? 'play' : 'pause'} size={15} color={theme.colors.text} />
            <Text style={styles.secondaryButtonText}>{paused ? 'Resume' : 'Pause'}</Text>
          </Pressable>
          <Pressable
            onPress={onDelete}
            disabled={updating}
            accessibilityRole="button"
            accessibilityLabel="Delete automation"
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed ? styles.pressed : null,
              updating ? styles.disabled : null,
            ]}
          >
            <Icon name="trash-2" size={15} color={theme.colors.tone.danger} />
            <Text style={[styles.secondaryButtonText, styles.dangerText]}>Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

export type AutomationProposalState = 'idle' | 'saving' | 'saved';

/** The card an agent's proposal renders as. Nothing is scheduled until the
 * operator taps the button; a proposal with a check script runs it once first. */
export function AutomationProposalCard({
  proposal,
  state,
  current,
  error,
  disabled,
  onConfirm,
}: {
  proposal: AutomationProposalMessage['proposal'];
  state: AutomationProposalState;
  /** `same`: this exact automation is already active; `other`: confirming replaces one. */
  current: 'none' | 'same' | 'other';
  error: string | null;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const { theme } = useUnistyles();
  const [showCheck, setShowCheck] = useState(false);
  const done = state === 'saved' || current === 'same';
  const inactive = disabled || done || state !== 'idle';
  const label = done
    ? 'Automation active'
    : state === 'saving'
      ? proposal.script
        ? 'Checking…'
        : 'Creating…'
      : current === 'other'
        ? 'Replace current automation'
        : 'Create automation';
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Icon name="repeat" size={16} color={theme.colors.primary} />
        <Text style={styles.cardEyebrow}>Recurring task</Text>
      </View>
      <Text style={styles.cardTitle}>{proposal.name}</Text>
      <Text style={styles.cardSchedule}>{automationScheduleLabel(proposal.schedule)}</Text>
      <Text style={styles.cardPrompt} numberOfLines={8}>
        {proposal.prompt}
      </Text>
      {proposal.script ? (
        <View style={styles.checkBlock}>
          <Text style={styles.cardHint}>
            A quick check runs first, and the agent only starts when there is something to do.
          </Text>
          <Pressable
            onPress={() => setShowCheck((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel={showCheck ? 'Hide check' : 'Show check'}
          >
            <Text style={styles.linkText}>{showCheck ? 'Hide check' : 'Show check'}</Text>
          </Pressable>
          {showCheck ? (
            <ScrollView style={styles.script} nestedScrollEnabled>
              <Text selectable style={styles.scriptText}>
                {proposal.script}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
      {current === 'other' && !done ? (
        <Text style={styles.cardHint}>
          This session already has an automation. It will be replaced.
        </Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <Pressable
        onPress={onConfirm}
        disabled={inactive}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: inactive }}
        style={[styles.confirm, inactive ? styles.disabled : null]}
      >
        {state === 'saving' ? (
          <ActivityIndicator size="small" color={theme.colors.background} />
        ) : done ? (
          <Icon name="check" size={16} color={theme.colors.background} />
        ) : null}
        <Text style={styles.confirmText}>{label}</Text>
      </Pressable>
    </View>
  );
}

/** One starting point on the empty-session screen. */
export function SessionStarterCard({
  icon,
  title,
  text,
  badge,
  onPress,
}: {
  icon: 'code' | 'message-circle' | 'repeat';
  title: string;
  text: string;
  badge?: string;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [
        styles.starter,
        badge ? styles.starterHighlighted : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.starterIcon}>
        <Icon name={icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={styles.starterBody}>
        <View style={styles.starterTitleRow}>
          <Text style={styles.starterTitle}>{title}</Text>
          {badge ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.starterText}>{text}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    minHeight: 40,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  barMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  barText: {
    flex: 1,
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  barSchedule: {
    color: theme.colors.textMuted,
    fontWeight: '400',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    maxHeight: '80%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
    marginBottom: theme.spacing.sm,
  },
  sheetEyebrow: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  sheetTitle: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    marginTop: 2,
    marginBottom: theme.spacing.sm,
  },
  sheetBody: {
    flexGrow: 0,
  },
  sheetBodyContent: {
    gap: theme.spacing.md,
    paddingBottom: theme.spacing.md,
  },
  section: {
    gap: 4,
  },
  sectionLabel: {
    color: theme.colors.textFaint,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  sectionText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  sectionHint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  sheetActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  secondaryButtonText: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  dangerText: {
    color: theme.colors.tone.danger,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.5,
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  cardEyebrow: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  cardTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  cardSchedule: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  cardPrompt: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  cardHint: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  checkBlock: {
    gap: theme.spacing.xs,
  },
  linkText: {
    color: theme.colors.primary,
    fontSize: theme.text.xs,
    fontWeight: '600',
  },
  script: {
    maxHeight: 200,
    padding: theme.spacing.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  scriptText: {
    color: theme.colors.text,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  errorText: {
    color: theme.colors.tone.danger,
    fontSize: theme.text.xs,
  },
  confirm: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  confirmText: {
    color: theme.colors.background,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  starter: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  starterHighlighted: {
    borderColor: theme.colors.primary,
  },
  starterIcon: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  starterBody: {
    flex: 1,
    gap: 2,
  },
  starterTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  starterTitle: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '700',
  },
  starterText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 18 * theme.fontScale,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
  },
  badgeText: {
    color: theme.colors.background,
    fontSize: 10 * theme.fontScale,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
}));
