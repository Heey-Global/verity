import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentProviderIcon } from '../../components/AgentProviderIcon';
import { Text } from '../../components/ui';
import { tint } from '../../components/ui/tint';

/** Sample data only: no server, invitation or credential is involved. */
export const ignore = () => undefined;

export const PROJECT = 'verity';

/** A page body with the app's standard padding and spacing. */
export function Page({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

/** A person's initials in the same tile size as a row's leading icon. */
export function Avatar({ initials, you = false }: { initials: string; you?: boolean }) {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor: tint(you ? theme.colors.action : theme.colors.signature, 'fill') },
      ]}
    >
      <Text variant="label" tone={you ? 'action' : 'signature'}>
        {initials}
      </Text>
    </View>
  );
}

export function ProviderMark({ provider }: { provider: 'claude' | 'codex' }) {
  const { theme } = useUnistyles();
  return <AgentProviderIcon provider={provider} color={theme.colors.action} size={18} />;
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  footer: {
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
