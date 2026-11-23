import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  providerName,
  pullRequestMergeButton,
  pullRequestStatusText,
  type PullRequestBlockReason,
} from '@verity/mobile';
import type { BranchPullRequest, UseBranches } from '../../hooks/useBranches';
import { CodeHostIcon } from '../CodeHostIcon';
import { Icon } from '../Icon';
import { SessionBar, SessionBarContent, SessionBarStack, SessionBarTarget } from '../ui/SessionBar';
import { Text } from '../ui/Text';
import { tint } from '../ui/tint';

const initialMergeState = { merging: false, mergeRejected: false };

function colorFor(
  pr: BranchPullRequest,
  kind: ReturnType<typeof pullRequestMergeButton>['kind'],
  colors: { attention: string; textFaint: string; success: string },
) {
  if (kind === 'blocked' || kind === 'refresh' || pr.pipeline === 'failure')
    return colors.attention;
  if (kind === 'waiting' || pr.phase === 'closed') return colors.textFaint;
  return colors.success;
}

function priority(pr: BranchPullRequest): number {
  if (pr.phase !== 'open') return 3;
  const { kind } = pullRequestMergeButton(pr, initialMergeState);
  if (kind === 'merge') return 1;
  if (kind === 'blocked' || kind === 'refresh' || pr.pipeline === 'failure') return 0;
  return 2;
}

export function PullRequestBarGroup({
  pullRequests,
  onDismiss,
  ...actions
}: Pick<
  Parameters<typeof PullRequestBar>[0],
  'confirmHint' | 'onMerge' | 'onRefresh' | 'codeHost' | 'repositoryName'
> & {
  pullRequests: BranchPullRequest[];
  onDismiss: (pr: BranchPullRequest) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { theme } = useUnistyles();
  if (pullRequests.length === 0) return null;
  const sorted = [...pullRequests].sort((a, b) => priority(a) - priority(b));
  const grouped = sorted.length > 1;
  const rows = sorted.map((pr) => (
    <PullRequestBar
      key={pr.url}
      {...actions}
      grouped={grouped}
      pullRequest={pr}
      onDismiss={pr.phase === 'open' ? undefined : () => onDismiss(pr)}
    />
  ));
  const first =
    sorted.find((pr) => priority(pr) === 0) ??
    sorted.find((pr) => priority(pr) === 2) ??
    sorted[0]!;
  const attention = sorted.filter((pr) => priority(pr) === 0).length;
  const ready = sorted.filter((pr) => priority(pr) === 1).length;
  const summary = [
    attention > 0 ? `${attention} need attention` : '',
    ready > 0 ? `${ready} ready` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const refs = sorted.map(
    (pr) => `${pr.repository?.name ?? actions.repositoryName ?? 'PR'} #${pr.number}`,
  );
  const title = `${sorted.length} pull requests${summary ? ` · ${summary}` : ''}`;
  return (
    <SessionBarStack grouped={grouped} collapsed={grouped && !expanded}>
      {grouped ? (
        <SessionBar inset first>
          <SessionBarTarget
            onPress={() => setExpanded((value) => !value)}
            expanded={expanded}
            accessibilityLabel={`${title}. ${refs.join(', ')}`}
          >
            <SessionBarContent
              color={colorFor(
                first,
                pullRequestMergeButton(first, initialMergeState).kind,
                theme.colors,
              )}
              title={title}
              subtitle={sorted.map((pr, index) => (
                <Text key={pr.url} variant="footnote" tone="muted">
                  {index > 0 ? '   ' : ''}
                  <Text
                    variant="footnote"
                    style={{
                      color: colorFor(
                        pr,
                        pullRequestMergeButton(pr, initialMergeState).kind,
                        theme.colors,
                      ),
                    }}
                  >
                    {'● '}
                  </Text>
                  {refs[index]}
                </Text>
              ))}
            />
            <Icon
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={theme.colors.textMuted}
            />
          </SessionBarTarget>
        </SessionBar>
      ) : null}
      <View style={grouped && !expanded ? styles.collapsed : undefined}>{rows}</View>
    </SessionBarStack>
  );
}

function PullRequestBar({
  grouped,
  repositoryName,
  confirmHint,
  pullRequest,
  onMerge,
  onRefresh,
  onDismiss,
  codeHost,
}: {
  confirmHint: () => Promise<boolean>;
  pullRequest: BranchPullRequest;
  grouped: boolean;
  repositoryName?: string;
  /** Absent for GitHub; the bar names and marks the host it opens. */
  codeHost: UseBranches['codeHost'];
  onMerge: UseBranches['mergePullRequest'];
  onRefresh: () => void;
  onDismiss?: () => void;
}) {
  const { theme } = useUnistyles();
  const [merging, setMerging] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [mergePermissionDenied, setMergePermissionDenied] = useState(false);
  const [mergeRetryable, setMergeRetryable] = useState(false);
  const [mergeRejectedFor, setMergeRejectedFor] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const { checks } = pullRequest;
  const pullRequestStateKey = [
    pullRequest.number,
    pullRequest.headSha ?? pullRequest.updatedAt ?? 'unknown',
    pullRequest.phase,
    pullRequest.pipeline,
    checks.completed,
    checks.total,
    checks.failed,
    checks.pending,
    pullRequest.mergeable === true
      ? 'mergeable'
      : pullRequest.mergeable === false
        ? 'blocked'
        : 'unknown',
    pullRequest.mergeState ?? 'no-state',
    String(pullRequest.viewerCanMerge),
  ].join(':');
  const pending = pullRequest.pipeline === 'running' || pullRequest.pipeline === 'pending';
  const mergeRejected = !pending && mergeRejectedFor === pullRequestStateKey && error !== undefined;
  const visibleError = mergeRejected && !mergeRetryable ? error : undefined;

  const checksText = pullRequestStatusText(pullRequest);
  // One verdict drives the dot and the button, so they cannot disagree. A conflicting
  // PR reads `unknown` with zero checks (GitHub builds no merge ref for it), and
  // `mergeable: null` right after a push means "still computing", not blocked — both
  // are resolved inside `pullRequestMergeButton`.
  const button = pullRequestMergeButton(
    mergeRejected && mergePermissionDenied
      ? { ...pullRequest, viewerCanMerge: false }
      : pullRequest,
    { merging, mergeRejected, mergeRetryable: mergeRejected && mergeRetryable },
  );
  const mergeButtonEnabled = button.kind === 'merge';
  const statusColor = colorFor(pullRequest, button.kind, theme.colors);
  const provider =
    (pullRequest.repository ? pullRequest.repository.codeHost : codeHost)?.provider ?? 'github';
  const repo = pullRequest.repository?.name ?? repositoryName;
  const label = repo ? `${repo} #${pullRequest.number}` : `PR #${pullRequest.number}`;
  const progress = pending && checks.total > 0 ? checks.completed / checks.total : undefined;
  const actionColor =
    button.kind === 'waiting'
      ? theme.colors.textMuted
      : button.kind === 'refresh'
        ? theme.colors.text
        : button.kind === 'blocked' && grouped
          ? theme.colors.attention
          : theme.colors.onAction;
  const conflictTarget = pullRequest.baseRef ?? 'the base branch';
  const prNumber = repo ? `${pullRequest.number} in ${repo}` : String(pullRequest.number);
  const blockedLabels: Record<PullRequestBlockReason, string> = {
    permission: `A maintainer must merge pull request ${prNumber}`,
    rejected: `Merge blocked because the forge rejected pull request ${prNumber}`,
    conflict: `Merge blocked because pull request ${prNumber} conflicts with ${conflictTarget}`,
    ci_failed: `Merge blocked because CI failed for pull request ${prNumber}`,
    blocked: `Merge blocked for pull request ${prNumber}`,
  };
  const buttonLabel =
    button.kind === 'blocked'
      ? blockedLabels[button.reason]
      : button.kind === 'refresh'
        ? `Refresh status of pull request ${prNumber}`
        : button.kind === 'waiting'
          ? `Merge unavailable for pull request ${prNumber}: ${checksText}`
          : button.kind === 'closed'
            ? `Pull request ${prNumber} is ${pullRequest.phase}`
            : `Merge pull request ${prNumber}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (mergeRejectedFor === undefined) return;
    if (!pending && mergeRejectedFor === pullRequestStateKey) return;
    setMergeRejectedFor(undefined);
    setError(undefined);
  }, [mergeRejectedFor, pending, pullRequestStateKey]);

  const merge = (): void => {
    if (!mergeButtonEnabled) return;
    void (async () => {
      setMerging(true);
      setError(undefined);
      setMergeRejectedFor(undefined);
      if (!(await confirmHint())) {
        if (mounted.current) setMerging(false);
        return;
      }
      if (!mounted.current) return;
      const result = await onMerge(
        pullRequest.number,
        pullRequest.repository?.id,
        pullRequest.headSha,
      );
      if (!mounted.current) return;
      setMerging(false);
      if (!result.ok) {
        setError(result.message);
        setMergePermissionDenied(result.permissionDenied === true);
        setMergeRetryable(result.retryable === true);
        setMergeRejectedFor(pullRequestStateKey);
        return;
      }
      // On success there's nothing more to do client-side: onMerge already
      // refreshed the branch/PR state, and the post-merge worktree reset +
      // agent notification happen server-side.
    })();
  };

  return (
    <SessionBar pressed={opening} inset={grouped} progress={progress}>
      <SessionBarTarget
        onPressIn={() => setOpening(true)}
        onPressOut={() => setOpening(false)}
        onPress={() =>
          void confirmHint().then((proceed) => {
            if (proceed && mounted.current)
              void Linking.openURL(pullRequest.url).catch(() => undefined);
          })
        }
        accessibilityRole="link"
        accessibilityLabel={`Open ${label} on ${providerName(provider)}`}
      >
        <SessionBarContent
          color={statusColor}
          title={`${label} · ${pullRequest.title}`}
          subtitle={
            pullRequest.phase === 'open' ? checksText : `${pullRequest.phase} · ${checksText}`
          }
        >
          {visibleError ? (
            <Text style={styles.prError} numberOfLines={1}>
              {visibleError}
            </Text>
          ) : null}
        </SessionBarContent>
      </SessionBarTarget>
      {onDismiss ? (
        <Pressable
          style={({ pressed }) => [
            styles.prMergeButton,
            styles.prDismissButton,
            pressed ? styles.prDismissButtonPressed : null,
          ]}
          onPress={() =>
            void confirmHint().then((proceed) => {
              if (proceed && mounted.current) onDismiss();
            })
          }
          accessibilityRole="button"
          accessibilityLabel={`Hide pull request ${prNumber} status`}
        >
          <CodeHostIcon provider={provider} size={16} color={theme.colors.textMuted} />
          <Text style={styles.prDismissText}>×</Text>
        </Pressable>
      ) : (
        <Pressable
          style={({ pressed }) => [
            styles.prMergeButton,
            button.kind === 'merge' || button.kind === 'merging'
              ? { backgroundColor: theme.colors.success }
              : button.kind === 'blocked'
                ? grouped
                  ? styles.blocked
                  : { backgroundColor: theme.colors.attention }
                : button.kind === 'waiting'
                  ? styles.prMergeButtonWaiting
                  : styles.prMergeButtonOutline,
            pressed && (mergeButtonEnabled || button.kind === 'refresh')
              ? styles.prMergeButtonPressed
              : null,
          ]}
          onPress={
            button.kind === 'refresh'
              ? () =>
                  void confirmHint().then((proceed) => {
                    if (proceed && mounted.current) {
                      setMergeRejectedFor(undefined);
                      setError(undefined);
                      onRefresh();
                    }
                  })
              : merge
          }
          disabled={!mergeButtonEnabled && button.kind !== 'refresh'}
          accessibilityRole="button"
          accessibilityState={{
            disabled: !mergeButtonEnabled && button.kind !== 'refresh',
            busy: button.kind === 'merging' || button.kind === 'waiting',
          }}
          accessibilityLabel={buttonLabel}
        >
          {button.kind === 'merging' ? (
            <ActivityIndicator color={theme.colors.onAction} />
          ) : button.kind === 'closed' ? null : (
            <>
              <CodeHostIcon provider={provider} size={16} color={actionColor} />
              <Text style={[styles.prMergeText, { color: actionColor }]} numberOfLines={1}>
                {button.label}
              </Text>
            </>
          )}
        </Pressable>
      )}
    </SessionBar>
  );
}

const styles = StyleSheet.create((theme) => ({
  collapsed: { display: 'none' },
  blocked: {
    backgroundColor: tint(theme.colors.attention, 'neutral'),
    borderColor: tint(theme.colors.attention, 'border'),
    borderWidth: 1,
  },
  prError: {
    color: theme.colors.attention,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
  prMergeButton: {
    width: 112,
    flexDirection: 'row',
    gap: theme.spacing.xs,
    height: 36,
    paddingHorizontal: theme.spacing.sm,
    marginRight: theme.spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.action,
  },
  prMergeButtonPressed: {
    opacity: 0.8,
  },
  prMergeButtonWaiting: {
    // Same surface as the bar behind it would read as bare text, so the waiting button
    // gets the stronger border tone as fill plus a visible edge to stay a button.
    backgroundColor: theme.colors.border,
    borderWidth: 1,
    borderColor: theme.colors.textFaint,
  },
  prMergeButtonOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: theme.colors.textMuted,
  },
  prMergeText: {
    color: theme.colors.onAction,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.bold,
  },
  prDismissButton: {
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  prDismissButtonPressed: {
    opacity: 0.55,
  },
  prDismissText: {
    color: theme.colors.textFaint,
    fontSize: theme.typography.title.fontSize,
    lineHeight: 24 * theme.fontScale,
    fontFamily: theme.fonts.regular,
  },
}));
