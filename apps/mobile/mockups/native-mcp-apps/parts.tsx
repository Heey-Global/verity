import { Stack } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button, IconButton } from '../../components/ui/Button';
import { Card, CardHead, Group, Row } from '../../components/ui/Card';
import { Text } from '../../components/ui/Text';

const ignore = () => undefined;

/** Static review compositions. No native app hosting or tool execution. */
export function NativeMcpSession({ state }: { state: 'ready' | 'loading' | 'error' }) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <IconButton icon="chevron-left" accessibilityLabel="Back" onPress={ignore} />
        <View style={styles.heading}>
          <Text variant="row">Find my documents</Text>
          <Text variant="caption">Heey Docs Privat</Text>
        </View>
        <IconButton icon="more-horizontal" accessibilityLabel="Session options" onPress={ignore} />
      </View>
      <View style={styles.content}>
        <Text variant="caption" style={styles.date}>
          Today · 19:45
        </Text>
        <View style={styles.request}>
          <Text>Show my latest documents.</Text>
        </View>
        <Text>Here are your latest documents.</Text>
        <Card stacked>
          <CardHead title="MCP · List Documents" />
          {state === 'ready' ? (
            <View style={styles.app}>
              <View style={styles.appHead}>
                <Text variant="row">Documents</Text>
                <Text variant="caption">3 documents</Text>
              </View>
              <Group>
                <Row
                  title="Project notes"
                  subtitle="Updated today · PDF"
                  leading={{ icon: 'file-text' }}
                />
                <Row
                  title="Meeting summary"
                  subtitle="Updated yesterday · PDF"
                  leading={{ icon: 'file-text' }}
                />
                <Row
                  title="Travel receipt"
                  subtitle="18 Nov · PDF"
                  leading={{ icon: 'file-text' }}
                />
              </Group>
              <Button
                label="Refresh documents"
                variant="secondary"
                size="compact"
                onPress={ignore}
              />
            </View>
          ) : state === 'loading' ? (
            <View style={styles.loading}>
              <ActivityIndicator color={theme.colors.action} />
              <Text tone="muted">Loading interactive app…</Text>
            </View>
          ) : (
            <View style={styles.app}>
              <Text tone="muted">The interactive app could not be loaded.</Text>
              <Button label="Try again" variant="secondary" size="compact" onPress={ignore} />
              <Text variant="label">Last result</Text>
              <View style={styles.result}>
                <Text variant="bodySmall">Project notes.pdf</Text>
                <Text variant="bodySmall">Meeting summary.pdf</Text>
                <Text variant="bodySmall">Travel receipt.pdf</Text>
              </View>
            </View>
          )}
        </Card>
      </View>
      <View style={styles.composer}>
        <View style={styles.input}>
          <Text tone="faint">Message…</Text>
          <IconButton icon="mic" accessibilityLabel="Voice message" onPress={ignore} />
        </View>
        <Text variant="caption" tone="faint">
          Verity
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    padding: theme.spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: { flex: 1, gap: theme.spacing.xxs },
  content: { flex: 1, padding: theme.spacing.lg, gap: theme.spacing.lg },
  date: { textAlign: 'center' },
  request: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.card,
    padding: theme.spacing.md,
  },
  app: { gap: theme.spacing.md },
  appHead: { gap: theme.spacing.xs },
  loading: {
    minHeight: 180,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  result: { gap: theme.spacing.sm },
  composer: {
    padding: theme.spacing.lg,
    gap: theme.spacing.sm,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  input: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: theme.spacing.lg,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
}));
