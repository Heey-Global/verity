import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedDevServer, SessionDevServer } from '@verity/mobile';
import { Icon } from '../Icon';

/**
 * One compact row per running server in the session, with the two ways to
 * reach it, named by who can see it: you on your own network, or anyone over
 * the internet with a PIN. The title names the server and its state rather
 * than its port, which says nothing to someone who did not start it.
 */
export function RunningServerCard({
  server,
  managed,
  opening,
  disabled,
  onOpen,
  onShare,
}: {
  server: SessionDevServer;
  managed?: ManagedDevServer | undefined;
  opening: boolean;
  disabled: boolean;
  onOpen: () => void;
  onShare: () => void;
}) {
  const { theme } = useUnistyles();
  return (
    <View
      style={styles.card}
      accessibilityLabel={
        server.managedInstanceId
          ? `${server.name} is running`
          : `${server.name} is running on port ${String(server.port)}`
      }
    >
      <View style={styles.title}>
        <View style={styles.dot} />
        <Text style={styles.name} numberOfLines={1}>
          {server.name}
          <Text style={styles.state}> · Server running</Text>
        </Text>
      </View>
      {managed ? (
        <Text selectable style={styles.command}>
          {managed.command}
          {managed.workdir !== '.' ? `\nin ${managed.workdir}` : ''}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          style={[styles.button, disabled && styles.buttonDisabled]}
          disabled={disabled}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`Open ${server.name} on your network`}
        >
          {opening ? (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          ) : (
            <Icon name="wifi" size={14} color={theme.colors.primary} />
          )}
          <Text style={styles.buttonText}>{opening ? 'Opening…' : 'Open on network'}</Text>
        </Pressable>
        <Pressable
          style={styles.button}
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel={`Share ${server.name} over the internet`}
        >
          <Icon name="globe" size={14} color={theme.colors.primary} />
          <Text style={styles.buttonText}>Share online</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Core reports a vanished listener in port terms. The operator only needs to
 * know the server is gone and how to get it back.
 */
export function openFailureAlert(
  serverName: string,
  message: string,
): { title: string; body: string } {
  if (/nothing in this session listens on that port/u.test(message)) {
    return {
      title: 'Server is not running',
      body: `${serverName} stopped. Ask the agent to start it again.`,
    };
  }
  return { title: 'Could not open preview', body: message || 'Try again.' };
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginHorizontal: theme.spacing.md,
    marginVertical: theme.spacing.xs,
    paddingVertical: theme.spacing.xs,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: theme.spacing.md,
    rowGap: theme.spacing.xs,
  },
  command: { color: theme.colors.textMuted, fontSize: theme.text.xs, flexBasis: '100%' },
  title: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexShrink: 1,
    minWidth: 120,
    minHeight: 40,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.tone.done },
  name: {
    flexShrink: 1,
    color: theme.colors.text,
    fontSize: 13 * theme.fontScale,
    fontWeight: '600',
  },
  state: { color: theme.colors.textMuted, fontWeight: '400' },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
    flexGrow: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  button: {
    flexDirection: 'row',
    gap: 6,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: theme.colors.primary, fontSize: 13 * theme.fontScale, fontWeight: '600' },
}));
