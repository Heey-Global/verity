import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ManagedDevServer, SessionDevServer } from '@verity/mobile';
import { Icon } from '../Icon';
import { Button } from '../ui';

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
  const identity = JSON.stringify([server.port, server.pid, server.managedInstanceId]);
  const [dismissed, setDismissed] = useState<string>();
  if (dismissed === identity) return null;
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
      <Pressable
        style={styles.dismiss}
        onPress={() => setDismissed(identity)}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss the running server hint for ${server.name}`}
      >
        <Icon name="x" size={18} color={theme.colors.textMuted} />
      </Pressable>
      {managed ? (
        <Text selectable style={styles.command}>
          {managed.command}
          {managed.workdir !== '.' ? `\nin ${managed.workdir}` : ''}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Open on network"
          accessibilityLabel={`Open ${server.name} on your network`}
          icon="wifi"
          variant="secondary"
          size="compact"
          loading={opening}
          disabled={disabled}
          onPress={onOpen}
        />
        <Button
          label="Share online"
          accessibilityLabel={`Share ${server.name} over the internet`}
          icon="globe"
          variant="secondary"
          size="compact"
          onPress={onShare}
        />
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
  dismiss: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  command: { ...theme.typography.footnote, color: theme.colors.textMuted, flexBasis: '100%' },
  title: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    flexShrink: 1,
    minWidth: 120,
    minHeight: 40,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success },
  name: {
    ...theme.typography.body,
    fontFamily: theme.fonts.semibold,
    flexShrink: 1,
    color: theme.colors.text,
  },
  state: { color: theme.colors.textMuted, fontFamily: theme.fonts.regular },
  actions: {
    flexDirection: 'row',
    gap: theme.spacing.xs,
    flexGrow: 1,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
}));
