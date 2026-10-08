import { Icon, type IconName } from './Icon';
import { Modal, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

/**
 * Shown once, on the first tap of the capture bubble, before anything records:
 * what the bubble does and how to drive it. Afterwards a tap records at once.
 */
export function QuickCaptureIntro({ onStart, onClose }: { onStart(): void; onClose(): void }) {
  const { theme } = useUnistyles();
  const point = (icon: IconName, title: string, text: string) => (
    <View style={styles.point} key={title}>
      <View style={styles.pointIcon}>
        <Icon name={icon} size={16} color={theme.colors.primary} />
      </View>
      <View style={styles.pointBody}>
        <Text style={styles.pointTitle}>{title}</Text>
        <Text style={styles.pointText}>{text}</Text>
      </View>
    </View>
  );
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Not now" onPress={onClose} style={StyleSheet.absoluteFill} />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.hero}>
            <View style={styles.heroRing}>
              <Icon name="mic" size={26} color={theme.colors.accent} />
            </View>
          </View>
          <Text style={styles.title} accessibilityRole="header">
            Capture a task by voice
          </Text>
          <Text style={styles.lead}>
            Say what needs doing and carry on. The task lands in the project you are in, or in
            General, and waits until you hand it to an agent.
          </Text>
          {point('mic', 'Tap to record', 'Recording stops by itself when you pause.')}
          {point(
            'check-square',
            'Hold to see your tasks',
            'The badge counts what is still open here.',
          )}
          {point(
            'move',
            'Drag it anywhere',
            'It snaps to the nearest edge. Drop it on ✕ to hide it.',
          )}
          <Pressable
            accessibilityRole="button"
            onPress={onStart}
            style={({ pressed }) => [styles.start, pressed ? styles.pressed : null]}
          >
            <Text style={styles.startLabel}>Start recording</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.later, pressed ? styles.pressed : null]}
          >
            <Text style={styles.laterLabel}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.xl,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg + 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.xl,
    gap: theme.spacing.md,
  },
  hero: {
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  heroRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.accent,
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  lead: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    lineHeight: 20 * theme.fontScale,
    textAlign: 'center',
    marginBottom: theme.spacing.sm,
  },
  point: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    alignItems: 'flex-start',
  },
  pointIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  pointBody: {
    flex: 1,
    gap: 2,
  },
  pointTitle: {
    color: theme.colors.text,
    fontSize: theme.text.sm,
    fontWeight: '600',
  },
  pointText: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  start: {
    marginTop: theme.spacing.sm,
    minHeight: 48,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLabel: {
    color: theme.colors.onPrimary,
    fontSize: theme.text.md,
    fontWeight: '700',
  },
  later: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  laterLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
  },
  pressed: {
    opacity: 0.7,
  },
}));
