import { planDecisionAnswer, planProposalContent, planProposalCounts } from '@verity/mobile';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Icon } from './Icon';
import { Button } from './ui';
import { useUnistyles } from 'react-native-unistyles';
import { StyleSheet } from 'react-native-unistyles';

/** The current proposal stays beside the input, where its decision is made. */
export function PinnedPlan({
  markdown,
  revision,
  sendNonce,
  updated,
  deciding,
  disabled,
  error,
  renderMarkdown,
  onDismiss,
  onImplement,
  onAnswerDecision,
}: {
  markdown: string;
  revision: number | undefined;
  sendNonce: number;
  updated: boolean;
  deciding: boolean;
  disabled: boolean;
  error: string | undefined;
  renderMarkdown(markdown: string): ReactNode;
  onDismiss(): void;
  onImplement(): void;
  /** Sends the answer to an open decision as a chat message; the agent then
   *  presents the plan revised without it. */
  onAnswerDecision(answer: string): void;
}) {
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const previousSend = useRef(sendNonce);
  useEffect(() => {
    setExpanded(true);
    setDetails(false);
  }, [markdown, revision]);
  useEffect(() => {
    if (previousSend.current !== sendNonce) {
      previousSend.current = sendNonce;
      setExpanded(false);
      setDetails(false);
    }
  }, [sendNonce]);
  const { height } = useWindowDimensions();
  const { theme } = useUnistyles();
  const content = planProposalContent(markdown);
  const blocked = deciding || disabled;
  // A plan with open decisions cannot be implemented: the server refuses it too.
  const undecided = content.decisions.length;
  return (
    <View style={styles.card}>
      <Pressable
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse plan' : 'Expand plan'}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.dot} />
        <Text style={styles.label}>Plan</Text>
        {updated ? <Text style={styles.updated}>Updated</Text> : null}
        <Text style={styles.count}>{planProposalCounts(markdown)}</Text>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
      {expanded ? (
        <>
          <ScrollView style={{ maxHeight: Math.min(240, height * 0.25) }}>
            {details ? (
              renderMarkdown(markdown)
            ) : (
              <>
                <Text style={styles.title}>{content.title}</Text>
                {content.steps.map((step, index) => {
                  const title = /^\*\*(.+?)\*\*/.exec(step)?.[1] ?? step.split(/\s+[—–]\s+/)[0];
                  return (
                    <View key={index} style={styles.step}>
                      <Text style={styles.stepTitle}>•</Text>
                      <Text style={[styles.stepTitle, styles.stepText]}>{title}</Text>
                    </View>
                  );
                })}
                {content.criteria.length > 0 ? (
                  <>
                    <Text style={styles.sectionLabel}>Acceptance criteria</Text>
                    {content.criteria.map((criterion, index) => (
                      <View key={index} style={styles.step}>
                        <Icon name="circle" size={12} color={theme.colors.textMuted} />
                        <Text style={[styles.description, styles.stepText]}>{criterion}</Text>
                      </View>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={details ? 'Hide full plan' : 'Show full plan'}
            onPress={() => setDetails(!details)}
          >
            <Text style={styles.description}>{details ? 'Hide full plan' : 'Show full plan'}</Text>
          </Pressable>
          {content.decisions.map((decision, index) => (
            // Outside the scroll area: an open decision blocks the plan, so its
            // answers stay in view however long the plan is.
            <View key={`${String(index)}:${decision.question}`} style={styles.decision}>
              <Text style={styles.stepTitle}>{decision.question}</Text>
              {decision.options.length > 0 ? (
                <View style={styles.options}>
                  {decision.options.map((option, optionIndex) => (
                    <Button
                      key={`${String(optionIndex)}:${option}`}
                      label={option === decision.recommended ? `${option} · recommended` : option}
                      accessibilityLabel={`Answer ${decision.question} with ${option}`}
                      size="compact"
                      variant={option === decision.recommended ? 'primary' : 'secondary'}
                      disabled={blocked}
                      onPress={() => onAnswerDecision(planDecisionAnswer(decision, option))}
                    />
                  ))}
                </View>
              ) : (
                <Text style={styles.description}>Answer in the chat.</Text>
              )}
            </View>
          ))}
        </>
      ) : null}
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      {undecided > 0 ? (
        <Text style={styles.description}>
          {undecided === 1
            ? 'Answer the open decision to implement.'
            : `Answer the ${String(undecided)} open decisions to implement.`}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel plan"
          disabled={blocked}
          onPress={onDismiss}
          style={({ pressed }) => [
            styles.button,
            styles.dismiss,
            blocked && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.dismissLabel}>Cancel plan</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Implement plan"
          accessibilityState={{ disabled: blocked || undecided > 0 }}
          disabled={blocked || undecided > 0}
          onPress={onImplement}
          style={({ pressed }) => [
            styles.button,
            styles.implement,
            (blocked || undecided > 0) && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.implementLabel}>Implement</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.attention,
    backgroundColor: theme.colors.surfaceAlt,
    gap: theme.spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.attention,
  },
  label: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  count: {
    marginLeft: 'auto',
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
  updated: {
    color: theme.colors.background,
    backgroundColor: theme.colors.signature,
    fontSize: theme.typography.caption.fontSize,
    fontFamily: theme.fonts.bold,
    textTransform: 'uppercase',
    borderRadius: theme.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.typography.row.fontSize,
    fontFamily: theme.fonts.bold,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  goal: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.bodySmall.fontSize,
    marginBottom: theme.spacing.sm,
  },
  step: { flexDirection: 'row', gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  number: {
    width: 22,
    height: 22,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberText: {
    color: theme.colors.text,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  stepText: { flex: 1 },
  sectionLabel: {
    ...theme.typography.label,
    color: theme.colors.textMuted,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  decision: {
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  stepTitle: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  description: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  button: {
    minWidth: 84,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
    borderWidth: 1,
  },
  dismiss: { borderColor: theme.colors.border, backgroundColor: 'transparent' },
  implement: { borderColor: theme.colors.action, backgroundColor: theme.colors.action },
  dismissLabel: {
    color: theme.colors.text,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  implementLabel: {
    color: theme.colors.onAction,
    fontSize: theme.typography.bodySmall.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  error: {
    color: theme.colors.attention,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
}));
