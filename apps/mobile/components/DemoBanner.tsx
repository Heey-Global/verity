import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';

import { exitDemoMode, restartDemoMode } from '../lib/demoMode';

export function DemoBanner() {
  const insets = useSafeAreaInsets();
  const [leaving, setLeaving] = useState(false);
  return (
    <View style={[styles.banner, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      <Text style={styles.text} accessibilityLiveRegion="polite">
        Demo · Local sample data and simulated AI. Do not enter real credentials.
      </Text>
      <View style={styles.actions}>
        <Pressable
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Reset demo"
          disabled={leaving}
          onPress={() => {
            router.replace('/');
            restartDemoMode();
          }}
        >
          <Text style={styles.label}>Reset demo</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel="Exit demo"
          disabled={leaving}
          onPress={() => {
            setLeaving(true);
            // Drop the demo detail route before restoring the saved connection.
            router.replace('/');
            void exitDemoMode().catch(() => {
              setLeaving(false);
              Alert.alert('Could not exit demo', 'Please try again.');
            });
          }}
        >
          <Text style={styles.label}>{leaving ? 'Exiting…' : 'Exit demo'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: {
    backgroundColor: theme.colors.setup.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.setup.border,
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  text: { color: theme.colors.setup.textMuted, fontSize: theme.text.xs },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.spacing.md },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.sm },
  label: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '600' },
}));
