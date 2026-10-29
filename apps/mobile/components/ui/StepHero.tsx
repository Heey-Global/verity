import { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '../Icon';
import { tint } from './tint';

/**
 * The opening of a step flow before anything is set up (docs/design-system.md
 * § 6): a two-line display headline whose second line is in the brand pink, and
 * one sentence under it.
 */
export function StepIntro({
  headline,
  accent,
  lead,
}: {
  headline: string;
  accent: string;
  lead: string;
}) {
  return (
    <View style={styles.intro}>
      <Text style={styles.headline} accessibilityRole="header">
        {headline}
        {'\n'}
        <Text style={styles.accent}>{accent}</Text>
      </Text>
      <Text style={styles.lead}>{lead}</Text>
    </View>
  );
}

/** The one brand moment at the end of a step flow: the check tile, a title and a
 *  short line under it. Pair it with `Confetti` above. */
export function SuccessHero({ title, lead }: { title: string; lead: ReactNode }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.hero}>
      <View style={styles.check}>
        <Icon name="check" size={40} color={theme.colors.signature} />
      </View>
      <Text style={styles.heroTitle} accessibilityRole="header">
        {title}
      </Text>
      <Text style={styles.heroLead}>{lead}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  intro: { gap: theme.spacing.sm, paddingTop: theme.spacing.md },
  headline: { ...theme.typography.display, color: theme.colors.text },
  accent: { color: theme.colors.signature },
  lead: { ...theme.typography.body, color: theme.colors.textMuted },
  hero: {
    alignItems: 'center',
    gap: 10,
    paddingTop: 34,
    paddingBottom: theme.spacing.md,
  },
  check: {
    width: 84,
    height: 84,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: tint(theme.colors.signature, 'border'),
    backgroundColor: tint(theme.colors.signature, 'fill'),
    shadowColor: theme.colors.signature,
    shadowOpacity: 0.35,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 0 },
  },
  heroTitle: { ...theme.typography.display, color: theme.colors.text, textAlign: 'center' },
  heroLead: { ...theme.typography.body, color: theme.colors.textMuted, textAlign: 'center' },
}));
