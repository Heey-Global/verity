import { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';
import { type SessionSummary } from '@verity/mobile';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon } from './Icon';
import { createVerityClient } from '../lib/client';
import { dispatchTaskIssue } from '../lib/taskIssueDispatch';

type Issue = {
  number: number;
  title: string;
  url: string;
  labels: string[];
  assignees: string[];
};
export function TaskIssuesList({
  projectId,
  projectName = projectId,
  currentSessionId,
  issues,
  viewerLogin,
  onOpenSession,
}: {
  projectId: string;
  projectName?: string;
  currentSessionId?: string;
  issues: Issue[];
  viewerLogin?: string | null;
  onOpenSession(id: string): void;
}) {
  const { theme } = useUnistyles();
  const [filter, setFilter] = useState<'all' | 'mine' | 'bugs'>('all');
  const [expanded, setExpanded] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setSessions([]);
    setFilter('all');
    setExpanded(false);
    void createVerityClient()
      ?.listSessions()
      .then((value) => {
        if (active) setSessions(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [projectId]);
  const filtered = issues.filter(
    (issue) =>
      filter === 'all' ||
      (filter === 'mine'
        ? issue.assignees.some((login) => login.toLowerCase() === viewerLogin?.toLowerCase())
        : issue.labels.some((label) => /^bugs?$/i.test(label))),
  );
  const chip = (
    label: string,
    onPress: () => void,
    selected = false,
    disabled = false,
    hint?: string,
  ) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected, disabled }}
      disabled={disabled || busy}
      onPress={onPress}
      style={[styles.chip, selected ? styles.selected : null, disabled ? styles.disabled : null]}
    >
      <Text style={[styles.chipText, selected ? styles.selectedText : null]}>{label}</Text>
    </Pressable>
  );
  const dispatch = (issue: Issue, target?: string) => {
    if (busy) return;
    setBusy(true);
    void dispatchTaskIssue(projectId, issue, target)
      .then(onOpenSession)
      .catch((error) =>
        Alert.alert('Issue action failed', error instanceof Error ? error.message : 'Try again'),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View>
      <View style={styles.chips}>
        {chip(
          'All',
          () => {
            setFilter('all');
            setExpanded(false);
          },
          filter === 'all',
        )}
        {chip(
          'Assigned to me',
          () => {
            setFilter('mine');
            setExpanded(false);
          },
          filter === 'mine',
          !viewerLogin,
          !viewerLogin
            ? 'Requires a personal GitHub connection to identify your assignments'
            : undefined,
        )}
        {chip(
          'Bugs',
          () => {
            setFilter('bugs');
            setExpanded(false);
          },
          filter === 'bugs',
        )}
      </View>
      <View style={styles.section}>
        <View style={styles.currentDot} />
        <Text style={styles.sectionLabel}>{projectName}</Text>
        <View style={styles.count}>
          <Text style={styles.countLabel}>{filtered.length} open</Text>
        </View>
      </View>
      {(expanded ? filtered : filtered.slice(0, 3)).map((issue) => {
        const session = sessions.find(
          (item) =>
            item.projectId === projectId &&
            item.resumable !== false &&
            item.branch?.match(/^[^/]+\/(\d+)(?:-|$)/)?.[1] === String(issue.number),
        );
        return (
          <View key={issue.number} style={styles.row}>
            <View style={styles.rowMain}>
              <View style={styles.icon}>
                <Icon name="circle" size={20} color={theme.colors.tone.done} />
              </View>
              <View style={styles.body}>
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`GitHub issue #${issue.number}: ${issue.title}`}
                  onPress={() => {
                    void Linking.openURL(issue.url).catch(() =>
                      Alert.alert('Could not open issue', 'Try again'),
                    );
                  }}
                >
                  <Text style={styles.title}>{issue.title}</Text>
                </Pressable>
                <Text style={styles.meta}>
                  #{issue.number}
                  {issue.labels.length ? ` · ${issue.labels.join(' · ')}` : ''}
                  {issue.assignees.length ? ` · ${issue.assignees.join(', ')}` : ''}
                </Text>
              </View>
            </View>
            <View style={[styles.chips, styles.indent]}>
              {session ? (
                chip('↳ Open session', () => onOpenSession(session.sessionId), true)
              ) : (
                <>
                  {currentSessionId
                    ? chip('↳ This Session', () => dispatch(issue, currentSessionId), true)
                    : null}
                  {chip('+ New Session', () => dispatch(issue))}
                </>
              )}
            </View>
          </View>
        );
      })}
      {!expanded && filtered.length > 3 ? (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(true)} style={styles.show}>
          <Text style={styles.link}>Show all {filtered.length} issues</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
  sectionLabel: {
    color: theme.colors.textMuted,
    fontSize: theme.text.xs,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  currentDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.primary },
  count: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 1,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  countLabel: { color: theme.colors.text, fontSize: theme.text.micro, fontWeight: '600' },
  row: {
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowMain: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  icon: { paddingTop: 2 },
  body: { flex: 1, gap: 2 },
  title: { color: theme.colors.text, fontSize: theme.text.md, lineHeight: 21 * theme.fontScale },
  meta: { color: theme.colors.textFaint, fontSize: theme.text.xs },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  indent: { marginLeft: 28 },
  chip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipText: { color: theme.colors.text, fontSize: theme.text.sm, fontWeight: '500' },
  selected: { borderColor: theme.colors.primary },
  selectedText: { color: theme.colors.primary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  show: { padding: theme.spacing.sm },
  link: { color: theme.colors.primary, fontSize: theme.text.sm },
}));
