// Preflight welcome. No server is selected yet, so this is deliberately not
// part of the numbered setup wizard.
import { type Href, router } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

const NEXT = '/onboarding/server-url' as Href;

export default function OnboardingWelcome() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.eyebrow}>Verity</Text>
        <Text style={styles.title} accessibilityRole="header">
          Welcome to Verity
        </Text>

        <View style={styles.card}>
          <Text style={styles.lead}>
            Verity lets you run AI coding agents on your own projects without handing every secret
            to a sandbox. Your server keeps credentials encrypted, mints short-lived access only
            when a project needs it, and stays under your control.
          </Text>
          <Text style={styles.lead}>
            Connect to your Verity server first; then this app can tell whether to unlock an
            existing install or start setup.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>What happens next</Text>
          <Text style={styles.item}>1. Choose the Verity server this device should control.</Text>
          <Text style={styles.item}>2. Unlock it or set the master password.</Text>
          <Text style={styles.item}>
            3. If setup is still incomplete, Verity guides you through GitHub, signing, projects,
            and optional services.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.footerSpacer} />
        <Pressable
          style={({ pressed }) => [styles.nextButton, pressed ? styles.pressed : null]}
          onPress={() => router.push(NEXT)}
          accessibilityRole="button"
          accessibilityLabel="Continue"
        >
          <Text style={styles.nextLabel}>Continue</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flexGrow: 1,
    gap: theme.spacing.lg,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xl,
  },
  eyebrow: {
    color: theme.colors.accent,
    fontSize: theme.text.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.xl,
    fontWeight: '800',
  },
  card: {
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  lead: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
  },
  sectionTitle: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  item: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  footerSpacer: {
    minWidth: 88,
  },
  nextButton: {
    minHeight: 48,
    minWidth: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.xl,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
  },
  nextLabel: {
    color: theme.colors.background,
    fontSize: theme.text.md,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.62,
  },
}));
