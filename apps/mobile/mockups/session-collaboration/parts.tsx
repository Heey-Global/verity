import type { CollaborationEntry } from '@verity/mobile';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CollaborationRow } from '../../components/session/collaboration';
import { Text } from '../../components/ui';

export const ignore = () => undefined;

/** A fixed moment, so the ages in the sheet render the same on every run. */
export const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export const SERVER_AUTH: CollaborationEntry = {
  sessionId: 'server-auth',
  sessionName: 'Auth refactor',
  projectId: 'server',
  projectName: 'Server',
  direction: 'asked',
  state: 'working',
  updatedAt: minutesAgo(4),
  section: 'current',
};
export const MOBILE_HEADER: CollaborationEntry = {
  sessionId: 'mobile-header',
  sessionName: 'Header rework',
  projectId: 'mobile',
  projectName: 'Mobile',
  direction: 'askedBy',
  state: 'answer',
  updatedAt: minutesAgo(12),
  section: 'current',
};
export const DOCS_ADR: CollaborationEntry = {
  sessionId: 'docs-adr',
  sessionName: 'ADR 0031',
  projectId: 'docs',
  projectName: 'Docs',
  direction: 'handedOver',
  state: 'done',
  updatedAt: minutesAgo(60),
  section: 'current',
};

/** The app's header row over sample entries; taps do nothing in a mockup. */
export function Line({ entries }: { entries: readonly CollaborationEntry[] }) {
  return <CollaborationRow entries={entries} onOpenEntry={ignore} onOpenList={ignore} />;
}

/** A session screen with the collaboration line under its header and a short chat. */
export function SessionWithLine({
  line,
  children,
  overlay,
}: {
  line: ReactNode;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={styles.header}>{line}</View>
      <ScrollView contentContainerStyle={styles.transcript}>{children}</ScrollView>
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, theme.spacing.sm) }]}>
        <Text variant="body" tone="faint">
          Message the agent…
        </Text>
      </View>
      {overlay}
    </View>
  );
}

export function UserMessage({ children }: { children: string }) {
  return (
    <View style={styles.userMessage}>
      <Text variant="body">{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  transcript: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  userMessage: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
  },
  composer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
}));
