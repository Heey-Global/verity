import { planDecisionAnswers, planProposalContent, planProposalCounts } from '@verity/mobile';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from './Icon';
import { Button, OptionList, Text } from './ui';
import { tint } from './ui/tint';

/** The card never takes more than this share of the visible window (above an
 *  open keyboard): whatever the plan holds, its actions and the composer below
 *  stay on screen. */
export const PINNED_PLAN_MAX_HEIGHT_SHARE = 0.55;

type Decision = ReturnType<typeof planProposalContent>['decisions'][number];

/** Each decision starts on its recommendation, so accepting them all is one tap. */
function initialAnswers(decisions: readonly Decision[]): (string | undefined)[] {
  return decisions.map((decision) =>
    decision.recommended !== undefined && decision.options.includes(decision.recommended)
      ? decision.recommended
      : undefined,
  );
}

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
  keyboardHeight = null,
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
  /** Height of the open software keyboard, which covers part of the window. */
  keyboardHeight?: number | null;
  onDismiss(): void;
  onImplement(): void;
  /** Sends the answers to the open decisions as one chat message; the agent
   *  then presents the plan revised without them. */
  onAnswerDecision(answer: string): void;
}) {
  const content = planProposalContent(markdown);
  const { decisions } = content;
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [stepsShown, setStepsShown] = useState(false);
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers] = useState(() => initialAnswers(decisions));
  const previousSend = useRef(sendNonce);
  useEffect(() => {
    // A new proposal asks its own questions: earlier selections do not carry over.
    setExpanded(true);
    setDetails(false);
    setStepsShown(false);
    setCurrent(0);
    setAnswers(initialAnswers(planProposalContent(markdown).decisions));
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
  const blocked = deciding || disabled;
  // A plan with open decisions cannot be implemented: the server refuses it too.
  const undecided = decisions.length;
  const answerable = decisions.flatMap((decision, index) =>
    decision.options.length > 0 ? [{ decision, option: answers[index] }] : [],
  );
  const chosen = answerable.flatMap(({ decision, option }) =>
    option === undefined ? [] : [{ decision, option }],
  );
  const complete = chosen.length > 0 && chosen.length === answerable.length;
  // A decision without options is answered in the chat, not by Send.
  const chatOnly = undecided - answerable.length;
  const index = Math.min(current, Math.max(undecided - 1, 0));
  const decision = decisions[index];

  const select = (option: string) => {
    setAnswers((previous) => previous.map((answer, at) => (at === index ? option : answer)));
    if (index < undecided - 1) setCurrent(index + 1);
  };

  const summary = (
    <>
      {content.steps.map((step, at) => {
        const title = /^\*\*(.+?)\*\*/.exec(step)?.[1] ?? step.split(/\s+[—–]\s+/)[0];
        return (
          <View key={at} style={styles.step}>
            <Text variant="bodySmall" tone="muted">
              •
            </Text>
            <Text variant="bodySmall" style={styles.stepText}>
              {title}
            </Text>
          </View>
        );
      })}
      {content.mockups.length > 0 ? (
        <>
          <Text variant="label" style={styles.sectionLabel}>
            Mockups
          </Text>
          {content.mockups.map((mockup, at) => (
            <View key={at} style={styles.step}>
              <Icon name="image" size={12} color={theme.colors.textMuted} />
              <Text variant="footnote" tone="muted" style={styles.stepText}>
                {mockup}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      {content.criteria.length > 0 ? (
        <>
          <Text variant="label" style={styles.sectionLabel}>
            Acceptance criteria
          </Text>
          {content.criteria.map((criterion, at) => (
            <View key={at} style={styles.step}>
              <Icon name="circle" size={12} color={theme.colors.textMuted} />
              <Text variant="footnote" tone="muted" style={styles.stepText}>
                {criterion}
              </Text>
            </View>
          ))}
        </>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show full plan"
        onPress={() => setDetails(true)}
      >
        <Text variant="subtitle" tone="action">
          Show full plan
        </Text>
      </Pressable>
    </>
  );

  return (
    <View
      testID="pinned-plan"
      style={[
        styles.card,
        {
          maxHeight: Math.round(
            Math.max(height - (keyboardHeight ?? 0), 0) * PINNED_PLAN_MAX_HEIGHT_SHARE,
          ),
        },
      ]}
    >
      <Pressable
        style={styles.header}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse plan' : 'Expand plan'}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.dot} />
        <Text
          variant="bodySmall"
          style={[styles.label, !expanded && styles.headerTitle]}
          numberOfLines={1}
        >
          {expanded ? 'Plan' : content.title}
        </Text>
        {updated ? <Text style={styles.updated}>Updated</Text> : null}
        <Text variant="footnote" tone="muted" style={styles.count} numberOfLines={1}>
          {expanded
            ? planProposalCounts(markdown)
            : undecided > 0
              ? `${String(undecided)} ${undecided === 1 ? 'decision' : 'decisions'}`
              : `${String(content.steps.length)} ${content.steps.length === 1 ? 'step' : 'steps'}`}
        </Text>
        <Icon
          name={expanded ? 'chevron-down' : 'chevron-up'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>
      {expanded ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {details ? (
            <>
              {renderMarkdown(markdown)}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Hide full plan"
                onPress={() => setDetails(false)}
              >
                <Text variant="subtitle" tone="action">
                  Hide full plan
                </Text>
              </Pressable>
            </>
          ) : (
            <View style={styles.summary}>
              <Text variant="row">{content.title}</Text>
              {undecided > 0 && !stepsShown ? (
                // Open decisions come first: the steps wait behind one tap.
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show plan steps"
                  onPress={() => setStepsShown(true)}
                >
                  <Text variant="subtitle" tone="action">
                    {`Show plan · ${String(content.steps.length)} ${content.steps.length === 1 ? 'step' : 'steps'}`}
                  </Text>
                </Pressable>
              ) : (
                summary
              )}
            </View>
          )}
          {decision !== undefined ? (
            <View style={styles.decision}>
              <View style={styles.decisionHead}>
                <Text variant="label">
                  {`Decision ${String(index + 1)} of ${String(undecided)}`}
                </Text>
                <View style={styles.progress}>
                  {decisions.map((_, at) => (
                    <View
                      key={at}
                      style={[
                        styles.progressDot,
                        at < index && styles.progressDone,
                        at === index && styles.progressCurrent,
                      ]}
                    />
                  ))}
                </View>
              </View>
              <Text variant="row">{decision.question}</Text>
              {decision.options.length > 0 ? (
                <OptionList
                  accessibilityLabel={decision.question}
                  options={decision.options}
                  selected={answers[index]}
                  recommended={decision.recommended}
                  disabled={blocked}
                  onSelect={select}
                />
              ) : (
                <Text variant="footnote" tone="muted">
                  Answer in the chat.
                </Text>
              )}
              {undecided > 1 ? (
                <View style={styles.stepNav}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Previous decision"
                    accessibilityState={{ disabled: index === 0 }}
                    disabled={index === 0}
                    onPress={() => setCurrent(index - 1)}
                    style={[styles.navButton, index === 0 && styles.navDisabled]}
                  >
                    <Icon name="chevron-left" size={16} color={theme.colors.textMuted} />
                    <Text variant="subtitle">Back</Text>
                  </Pressable>
                  {index < undecided - 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Next decision"
                      onPress={() => setCurrent(index + 1)}
                      style={styles.navButton}
                    >
                      <Text variant="subtitle">Next</Text>
                      <Icon name="chevron-right" size={16} color={theme.colors.textMuted} />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      {error !== undefined ? (
        <Text variant="footnote" tone="attention">
          {error}
        </Text>
      ) : null}
      {undecided > 0 && expanded && answerable.length > 0 && !complete ? (
        <Text variant="footnote" tone="muted">
          Choose an answer for each decision to send them.
        </Text>
      ) : null}
      {expanded && chatOnly > 0 && answerable.length > 0 ? (
        <Text variant="footnote" tone="muted">
          {chatOnly === 1
            ? 'One decision has no options: answer it in the chat.'
            : `${String(chatOnly)} decisions have no options: answer them in the chat.`}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Cancel plan"
          variant="secondary"
          size="compact"
          disabled={blocked}
          onPress={onDismiss}
        />
        {undecided > 0 ? (
          <Button
            label={`Send answers (${String(chosen.length)})`}
            accessibilityLabel="Send answers"
            accessibilityHint="The agent revises the plan from your answers."
            size="compact"
            disabled={blocked || (expanded && !complete)}
            onPress={() => {
              // Collapsed, the answers are out of sight: show them before sending.
              if (!expanded) setExpanded(true);
              else onAnswerDecision(planDecisionAnswers(chosen));
            }}
          />
        ) : (
          <Button
            label="Implement"
            accessibilityLabel="Implement plan"
            size="compact"
            disabled={blocked}
            onPress={onImplement}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    padding: theme.spacing.md,
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
  label: { fontFamily: theme.fonts.semibold },
  headerTitle: { flexShrink: 1 },
  count: { marginLeft: 'auto', flexShrink: 0 },
  updated: {
    ...theme.typography.caption,
    color: theme.colors.background,
    backgroundColor: theme.colors.signature,
    fontFamily: theme.fonts.bold,
    textTransform: 'uppercase',
    borderRadius: theme.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  scroll: { flexShrink: 1 },
  scrollContent: { gap: theme.spacing.lg },
  summary: { gap: theme.spacing.sm },
  step: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  stepText: { flex: 1 },
  sectionLabel: { marginTop: theme.spacing.xs },
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
