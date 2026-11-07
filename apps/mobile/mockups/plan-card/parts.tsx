import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ReactNode } from 'react';

import { Icon } from '../../components/Icon';
import { PINNED_PLAN_MAX_HEIGHT_SHARE } from '../../components/PinnedPlan';
import { Button, OptionList, Text } from '../../components/ui';
import { tint } from '../../components/ui/tint';

const ignore = () => undefined;

export interface SampleDecision {
  question: string;
  options: readonly string[];
  recommended: string;
}

export const SAMPLE_TITLE = 'Wiki als lesbares, gepflegtes Projektwissen';
export const SAMPLE_STEPS = [
  'Server: Wiki-Katalog.',
  'App: Wiki-Startseite.',
  'App: Seiten lesbar und verlinkt.',
  'Wiki-Konventionen.',
  'Pflege-Skill `wiki-maintain`.',
  'Pflegebedarf erfassen.',
  'Pflege ausführen.',
  'Erstbefüllung.',
];

/** The three decisions from the screenshot that broke the old card. */
export const SAMPLE_DECISIONS: readonly SampleDecision[] = [
  {
    question: 'Woher kommt der Überblick auf der Startseite?',
    options: [
      'Gepflegte Seite `index.md`, die Verity schreibt, plus automatische Abschnitte für Entscheidungen, Zuletzt aktualisiert und Zu prüfen',
      'Nur automatisch aus der Seitenliste erzeugt, ohne gepflegten Text',
    ],
    recommended:
      'Gepflegte Seite `index.md`, die Verity schreibt, plus automatische Abschnitte für Entscheidungen, Zuletzt aktualisiert und Zu prüfen',
  },
  {
    question: 'Wie schreibt die Pflege ins Wiki?',
    options: [
      'Direkt, mit Änderungsprotokoll und Hinweis; Widersprüche landen unter „Zu prüfen“',
      'Nur als Vorschlag, den ich vorher freigebe',
    ],
    recommended:
      'Direkt, mit Änderungsprotokoll und Hinweis; Widersprüche landen unter „Zu prüfen“',
  },
  {
    question: 'Wann läuft die Pflege?',
    options: [
      'Nach jedem Anlass (gebündelt) plus wöchentliche Prüfung',
      'Nur wöchentlich',
      'Nur auf Anfrage',
    ],
    recommended: 'Nach jedem Anlass (gebündelt) plus wöchentliche Prüfung',
  },
];

/** One decision at a time, with the position among all of them. */
export function DecisionStepper({
  index,
  answers,
}: {
  index: number;
  /** The selected answer per decision; the recommendation until changed. */
  answers: readonly (string | undefined)[];
}) {
  const { theme } = useUnistyles();
  const decision = SAMPLE_DECISIONS[index]!;
  const last = index === SAMPLE_DECISIONS.length - 1;
  return (
    <View style={styles.decision}>
      <View style={styles.decisionHead}>
        <Text variant="label">
          {`Decision ${String(index + 1)} of ${String(SAMPLE_DECISIONS.length)}`}
        </Text>
        <View style={styles.progress}>
          {SAMPLE_DECISIONS.map((_, position) => (
            <View
              key={position}
              style={[
                styles.progressDot,
                position < index && styles.progressDone,
                position === index && styles.progressCurrent,
              ]}
            />
          ))}
        </View>
      </View>
      <Text variant="row">{decision.question}</Text>
      <OptionList
        options={decision.options}
        selected={answers[index]}
        recommended={decision.recommended}
        onSelect={ignore}
      />
      <View style={styles.stepNav}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous decision"
          disabled={index === 0}
          onPress={ignore}
          style={[styles.navButton, index === 0 && styles.navDisabled]}
        >
          <Icon name="chevron-left" size={16} color={theme.colors.textMuted} />
          <Text variant="subtitle">Back</Text>
        </Pressable>
        {!last ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next decision"
            onPress={ignore}
            style={styles.navButton}
          >
            <Text variant="subtitle">Next</Text>
            <Icon name="chevron-right" size={16} color={theme.colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The pinned card: header and actions fixed, everything between scrolls. */
export function PlanCard({
  expanded = true,
  body,
  footnote,
  primary,
  primaryDisabled = false,
  counts = '8 steps · 6 criteria · 3 decisions',
}: {
  counts?: string;
  expanded?: boolean;
  body?: ReactNode;
  footnote?: string;
  primary: string;
  primaryDisabled?: boolean;
}) {
  const { theme } = useUnistyles();
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.card, { maxHeight: Math.round(height * PINNED_PLAN_MAX_HEIGHT_SHARE) }]}>
      <Pressable accessibilityRole="button" onPress={ignore} style={styles.header}>
        <View style={styles.dot} />
        {expanded ? (
          <Text variant="bodySmall" style={styles.headerLabel}>
            Plan
          </Text>
        ) : (
          <Text
            variant="bodySmall"
            style={[styles.headerLabel, styles.headerTitle]}
            numberOfLines={1}
          >
            {SAMPLE_TITLE}
          </Text>
        )}
        <Text variant="footnote" style={styles.count} numberOfLines={1}>
          {counts}
        </Text>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-up'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
      {expanded && body !== undefined ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {body}
        </ScrollView>
      ) : null}
      {footnote !== undefined ? (
        <Text variant="footnote" tone="muted">
          {footnote}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label="Cancel plan" variant="secondary" size="compact" onPress={ignore} />
        <Button label={primary} size="compact" disabled={primaryDisabled} onPress={ignore} />
      </View>
    </View>
  );
}

/** Title and step titles, as the card shows them before "Show full plan". */
export function PlanSummary({ steps = true }: { steps?: boolean }) {
  if (!steps)
    return (
      <View style={styles.summary}>
        <Text variant="row">{SAMPLE_TITLE}</Text>
        <Text variant="subtitle" tone="action">
          {`Show plan · ${String(SAMPLE_STEPS.length)} steps`}
        </Text>
      </View>
    );
  return (
    <View style={styles.summary}>
      <Text variant="row">{SAMPLE_TITLE}</Text>
      {SAMPLE_STEPS.map((step) => (
        <View key={step} style={styles.step}>
          <Text variant="bodySmall" tone="muted">
            •
          </Text>
          <Text variant="bodySmall" style={styles.stepText}>
            {step}
          </Text>
        </View>
      ))}
      <Text variant="subtitle" tone="action">
        Show full plan
      </Text>
    </View>
  );
}

/** A session with the plan pinned above the composer, as on a phone. */
export function SessionWithPlan({
  card,
  reply = 'Der Plan steht. Drei Punkte musst du entscheiden, bevor ich umsetzen kann.',
}: {
  card: ReactNode;
  reply?: string;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.transcript}>
        <View style={styles.userMessage}>
          <Text variant="body">Plane das Wiki als gepflegtes Projektwissen.</Text>
        </View>
        <Text variant="body">{reply}</Text>
      </ScrollView>
      {card}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
        <Text variant="body" tone="faint">
          Message the agent…
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  transcript: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composer: {
    paddingTop: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: tint(theme.colors.attention, 'border'),
    backgroundColor: theme.colors.surfaceAlt,
    gap: theme.spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.attention,
  },
  headerLabel: { fontFamily: theme.fonts.semibold },
  headerTitle: { flexShrink: 1 },
  count: { marginLeft: 'auto', flexShrink: 0 },
  scroll: { flexShrink: 1 },
  scrollContent: { gap: theme.spacing.lg },
  summary: { gap: theme.spacing.sm },
  step: { flexDirection: 'row', gap: theme.spacing.sm },
  stepText: { flex: 1 },
  decision: {
    gap: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  decisionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { flexDirection: 'row', gap: theme.spacing.xs },
  progressDot: {
    width: 6,
    height: 6,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.border,
  },
  progressDone: { backgroundColor: theme.colors.action },
  progressCurrent: { width: 16, backgroundColor: theme.colors.action },
  stepNav: { flexDirection: 'row', justifyContent: 'space-between' },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xxs,
    paddingVertical: theme.spacing.xs,
  },
  navDisabled: { opacity: 0.4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.sm },
}));
