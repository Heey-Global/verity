import { parseBranchIssue, githubRefUrl, type RepoIdentity } from '@verity/mobile';
import type { RefCallback } from 'react';
import { Linking, Pressable, Text, type View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The issue a session works on, as a bare `#123` on its overview row — read off
 * the `<type>/<issue>-<slug>` branch the same way the session header does.
 * Renders nothing for a branch without an issue number. Tappable (opens the
 * GitHub issue) only when the repo is known, so a local project never gets a
 * broken link.
 */
export function SessionIssueRef({
  branch,
  repo,
  dragExcludedRef,
}: {
  dragExcludedRef?: RefCallback<View>;
  branch: string | undefined;
  repo: RepoIdentity | undefined;
}) {
  const issue = parseBranchIssue(branch);
  if (issue === null) return null;
  const label = `#${String(issue)}`;
  const url = githubRefUrl('issue', repo ?? {}, issue);
  if (url === null) {
    return (
      <Text style={styles.text} accessibilityLabel={`Issue ${String(issue)}`}>
        {label}
      </Text>
    );
  }
  return (
    <Pressable
      ref={dragExcludedRef}
      collapsable={false}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={`Issue ${String(issue)}. Open on GitHub.`}
      onPress={(event) => {
        // The row around it opens the session; on web that is a link the click
        // would otherwise bubble up to, navigating away instead of opening GitHub.
        event.stopPropagation();
        // openURL rejects only if no handler can open the URL; swallow it.
        void Linking.openURL(url).catch(() => undefined);
      }}
    >
      <Text style={[styles.text, styles.link]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The row's second-line text (`rowSub` on the overview).
  text: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    lineHeight: 17 * theme.fontScale,
  },
  // Tappable like the preview icon beside it, so it takes that icon's color.
  link: { color: theme.colors.primary },
}));
