import { planProposalContent, planProposalFullyRepresented } from '@verity/mobile';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** The current proposal stays beside the input, where its decision is made. */
export function PinnedPlan({
  markdown,
  updated,
  deciding,
  disabled,
  error,
  onDismiss,
  onImplement,
}: {
  markdown: string;
  updated: boolean;
  deciding: boolean;
  disabled: boolean;
  error: string | undefined;
  onDismiss(): void;
  onImplement(): void;
}) {
  const content = planProposalContent(markdown);
  const blocked = deciding || disabled;
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.dot} />
        <Text style={styles.label}>Plan</Text>
        {updated ? <Text style={styles.updated}>Updated</Text> : null}
        <Text style={styles.count}>{content.steps.length} steps</Text>
      </View>
      <ScrollView style={styles.content}>
        {planProposalFullyRepresented(markdown) ? (
          <>
            <Text style={styles.title}>{content.title}</Text>
            <Text style={styles.goal}>{content.goal}</Text>
            {content.steps.map((step, index) => {
              const match = /^\*\*(.+?)\*\*\s*(?:[—–-]\s*)?([\s\S]*)$/.exec(step);
              return (
                <View key={`${index}:${step}`} style={styles.step}>
                  <View style={styles.number}>
                    <Text style={styles.numberText}>{index + 1}</Text>
                  </View>
                  <View style={styles.stepText}>
                    <Text style={styles.stepTitle}>{match?.[1] ?? step}</Text>
                    {match?.[2] ? <Text style={styles.description}>{match[2]}</Text> : null}
                  </View>
                </View>
              );
            })}
          </>
        ) : (
          <Text style={styles.goal} selectable>
            {markdown}
          </Text>
        )}
      </ScrollView>
      {error !== undefined ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss plan"
          disabled={blocked}
          onPress={onDismiss}
          style={({ pressed }) => [
            styles.button,
            styles.dismiss,
            blocked && styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.dismissLabel}>Dismiss</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Implement plan"
          disabled={blocked}
          onPress={onImplement}
          style={({ pressed }) => [
            styles.button,
            styles.implement,
            blocked && styles.disabled,
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
    borderColor: theme.colors.tone.attention,
    backgroundColor: theme.colors.surfaceAlt,
    gap: theme.spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.tone.attention,
  },
  label: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  count: { marginLeft: 'auto', color: theme.colors.textMuted, fontSize: theme.text.xs },
  updated: {
    color: theme.colors.background,
    backgroundColor: theme.colors.accent,
    fontSize: theme.text.micro,
    fontWeight: '700',
    textTransform: 'uppercase',
    borderRadius: theme.radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  content: { maxHeight: 320 },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '700',
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.sm,
  },
  goal: { color: theme.colors.textMuted, fontSize: theme.text.sm, marginBottom: theme.spacing.sm },
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
  numberText: { color: theme.colors.text, fontSize: theme.text.xs, fontWeight: '600' },
  stepText: { flex: 1 },
  stepTitle: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  description: { color: theme.colors.textMuted, fontSize: theme.text.xs },
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
  implement: { borderColor: theme.colors.primary, backgroundColor: theme.colors.primary },
  dismissLabel: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
  implementLabel: { color: theme.colors.onPrimary, fontSize: theme.text.sm, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.xs },
}));
