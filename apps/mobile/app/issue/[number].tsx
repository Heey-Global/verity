// Issue detail (#137): read one GitHub issue (title + body, handed over from the
// overview row via route params so there's no second fetch) and, with one tap,
// spawn a fresh session seeded with it that starts working immediately. The spawn
// reuses POST /sessions (`createSession`) with the issue number so the new
// worktree branch is `feat/<n>-…` and the session header shows `Issue #N`.
//
// All StyleSheet.create lives here so the unistyles Babel plugin (root: 'app')
// processes it.
import { VerityApiError, type VerityClient, buildIssuePrompt } from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createVerityClient } from '../../lib/client';

/** Coerce an expo-router param (string | string[] | undefined) to a single string. */
function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export function verifiedGitHubIssueUrl(raw: string, number: number): string | null {
  try {
    const parsed = new URL(raw);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'github.com' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !new RegExp(`^/[^/]+/[^/]+/issues/${String(number)}$`, 'u').test(parsed.pathname)
    )
      return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export default function IssueDetailScreen() {
  const params = useLocalSearchParams<{
    number: string;
    title?: string;
    body?: string;
    url?: string;
    projectId?: string;
  }>();
  const client = useMemo(() => createVerityClient(), []);
  const number = Number(param(params.number));

  if (!client || !Number.isInteger(number) || number <= 0) {
    return (
      <View style={styles.centered}>
        <Stack.Screen options={{ title: 'Issue' }} />
        <Text style={styles.title}>Issue unavailable</Text>
        <Text style={styles.subtitle}>
          This issue couldn&apos;t be opened. Go back and pick it from the list again.
        </Text>
      </View>
    );
  }

  return (
    <IssueDetail
      client={client}
      number={number}
      title={param(params.title)}
      body={param(params.body)}
      url={param(params.url)}
      projectId={param(params.projectId) || undefined}
    />
  );
}

function IssueDetail({
  client,
  number,
  title,
  body,
  url,
  projectId,
}: {
  client: VerityClient;
  number: number;
  title: string;
  body: string;
  url: string;
  projectId?: string;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const issueUrl = verifiedGitHubIssueUrl(url, number);

  const onWork = useCallback(() => {
    if (starting) return;
    setStarting(true);
    setError(undefined);
    void (async () => {
      try {
        const prompt = buildIssuePrompt({ number, title, body });
        const result = await client.createSession({
          prompt,
          ...(projectId ? { projectId } : {}),
          // The session name (header + branch slug) is the issue title, capped to the
          // server's 80-char limit; the issue # makes the branch `feat/<n>-…`.
          name: title.trim().slice(0, 80) || `issue-${String(number)}`,
          issue: number,
        });
        if ('awaitingProvisioning' in result) {
          setError(
            `Provisioning ${result.project.owner}/${result.project.repo}. Try again shortly.`,
          );
          setStarting(false);
          return;
        }
        await client.sendTurn(result.sessionId, { prompt });
        // replace so Back returns to the overview, not this (now-consumed) detail.
        router.replace({
          pathname: '/session/[id]',
          params: { id: result.sessionId },
        });
      } catch (caught) {
        setError(caught instanceof VerityApiError ? caught.message : 'Could not start the session');
        setStarting(false);
      }
    })();
  }, [client, number, title, body, projectId, starting]);

  return (
    <View style={styles.flex}>
      <Stack.Screen options={{ title: `Issue #${String(number)}` }} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.issueNumber}>Issue #{number}</Text>
        <Text style={styles.title}>{title || '(untitled issue)'}</Text>
        {body.trim().length > 0 ? (
          <Text style={styles.body}>{body.trim()}</Text>
        ) : (
          <Text style={styles.bodyEmpty}>No description.</Text>
        )}
        {issueUrl !== null ? (
          <Pressable
            onPress={() => void Linking.openURL(issueUrl)}
            accessibilityRole="link"
            hitSlop={8}
          >
            <Text style={styles.link}>Open on GitHub ↗</Text>
          </Pressable>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          style={[styles.start, starting ? styles.startDisabled : null]}
          onPress={onWork}
          disabled={starting}
          accessibilityRole="button"
          accessibilityLabel={`Work on issue ${String(number)} now in a new session`}
        >
          {starting ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={styles.startLabel}>Work on it now</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flex: { flex: 1, backgroundColor: theme.colors.background },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    backgroundColor: theme.colors.background,
  },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  issueNumber: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    color: theme.colors.text,
    fontSize: theme.text.lg,
    fontWeight: '700',
    lineHeight: 26 * theme.fontScale,
  },
  subtitle: {
    color: theme.colors.textMuted,
    fontSize: theme.text.sm,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 20 * theme.fontScale,
  },
  body: {
    color: theme.colors.text,
    fontSize: theme.text.md,
    lineHeight: 22 * theme.fontScale,
    marginTop: theme.spacing.xs,
  },
  bodyEmpty: {
    color: theme.colors.textFaint,
    fontSize: theme.text.sm,
    fontStyle: 'italic',
    marginTop: theme.spacing.xs,
  },
  link: {
    color: theme.colors.primary,
    fontSize: theme.text.sm,
    fontWeight: '600',
    marginTop: theme.spacing.sm,
  },
  error: { color: theme.colors.tone.danger, fontSize: theme.text.sm, marginTop: theme.spacing.sm },
  footer: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  start: {
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  startDisabled: { backgroundColor: theme.colors.border },
  startLabel: { color: theme.colors.onPrimary, fontSize: theme.text.md, fontWeight: '700' },
}));
