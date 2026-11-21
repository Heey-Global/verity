import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  Card,
  IconButton,
  CardHead,
  FilterChips,
  Group,
  Row,
  StatusDot,
  StatusTag,
  Text,
  TileMark,
} from '../../components/ui';
import type { StatusIntent } from '../../components/ui/Status';

export const ignore = () => undefined;

/** Sample data only: the per-project QA role states the server would report. */
export type QAState = 'needsYou' | 'working' | 'clear' | 'access' | 'paused' | 'off';

interface Source {
  label: string;
  intent: StatusIntent;
}

const STATES: Record<
  QAState,
  {
    subtitle: string;
    marker?: ReactNode;
    sources: readonly Source[];
    checked?: string;
  }
> = {
  needsYou: {
    subtitle: '3 open · 1 repair running',
    marker: <StatusTag intent="needsSetup" label="Needs you" />,
    sources: [
      { label: 'PRs 1', intent: 'needsSetup' },
      { label: 'CI ok', intent: 'ready' },
    ],
    checked: 'Checked 08:12',
  },
  working: {
    subtitle: '2 repairs running',
    marker: <StatusTag intent="transient" label="Repairing" />,
    sources: [
      { label: 'PRs 2', intent: 'optional' },
      { label: 'CI ok', intent: 'ready' },
    ],
    checked: 'Checked 08:12',
  },
  clear: {
    subtitle: 'Nothing open',
    marker: <StatusTag intent="ready" label="All clear" />,
    sources: [
      { label: 'PRs ok', intent: 'ready' },
      { label: 'CI ok', intent: 'ready' },
    ],
    checked: 'Checked 08:12',
  },
  access: {
    subtitle: "Can't read Actions since 06:40",
    marker: <StatusTag intent="needsSetup" label="Check access" />,
    sources: [
      { label: 'PRs ok', intent: 'ready' },
      { label: 'CI unreadable', intent: 'unknown' },
    ],
  },
  paused: {
    subtitle: 'Paused by you since Monday',
    marker: <StatusTag intent="unknown" label="Paused" />,
    sources: [],
  },
  off: {
    subtitle: 'Switched off for this project',
    sources: [],
  },
};

/**
 * The QA entry of a project's Roles group: state instead of a last message,
 * and under it which sources were read and when. Green only after a fresh,
 * complete check; a paused or switched-off QA states no sources at all.
 */
export function QARoleRow({ state }: { state: QAState }) {
  const sample = STATES[state];
  const off = state === 'off';
  return (
    <Row
      title="QA"
      subtitle={sample.subtitle}
      leading={{
        icon: 'shield',
        ...(state === 'needsYou' || state === 'access' ? { intent: 'needsSetup' as const } : {}),
        ...(off || state === 'paused' ? { quiet: true } : {}),
        ...(state === 'working'
          ? { marks: { bottom: <TileMark tone="action" glyph="loader" /> } }
          : {}),
      }}
      trailing={off ? <Text variant="button">Turn on</Text> : sample.marker}
      navigates={!off}
      onPress={ignore}
      answers={
        sample.sources.length > 0 ? (
          <View style={styles.sources}>
            {sample.sources.map((source) => (
              <StatusDot key={source.label} intent={source.intent} label={source.label} />
            ))}
            {sample.checked ? (
              <Text variant="footnote" tone="faint">
                {sample.checked}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
    />
  );
}

/** The head of the QA page: what QA reads and how fresh it is, one column per source. */
export function QAStatusCard() {
  return (
    <Card stacked divided>
      <CardHead
        title="Watching website"
        subtitle="Repairs within mandate · checked 08:12"
        leading={{ icon: 'shield' }}
        trailing={<StatusTag intent="needsSetup" label="Needs you" />}
      />
      <View style={styles.columns}>
        <View style={styles.column}>
          <Text variant="label">Pull requests</Text>
          <StatusDot intent="needsSetup" label="1 failing · 6 open" />
        </View>
        <View style={styles.column}>
          <Text variant="label">CI on main</Text>
          <StatusDot intent="ready" label="Passing" />
        </View>
      </View>
    </Card>
  );
}

export function QATabs({ value }: { value: 'issues' | 'chat' }) {
  return (
    <FilterChips
      accessibilityLabel="QA sections"
      options={[
        { value: 'issues', label: 'Issues · 3' },
        { value: 'chat', label: 'Chat' },
      ]}
      value={value}
      onChange={ignore}
    />
  );
}

/** A page of the QA role: scrolling content, optionally a fixed footer (the chat composer). */
export function QAPage({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      {footer}
    </View>
  );
}

/** A compact card in the chat that points at an issue instead of repeating it. */
export function IssueReference({
  title,
  subtitle,
  tag,
}: {
  title: string;
  subtitle: string;
  tag: ReactNode;
}) {
  return (
    <Group>
      <Row
        title={title}
        subtitle={subtitle}
        leading={{ icon: 'shield', quiet: true }}
        trailing={tag}
        navigates
        onPress={ignore}
      />
    </Group>
  );
}

/** A scrolling screen with the standard page padding. */
export function Screen({ children }: { children: ReactNode }) {
  return <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>;
}

/** A full-height screen whose content scrolls above a fixed footer (Home's tab bar). */
export function FramedScreen({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
      {footer}
    </View>
  );
}

export function Fill({ children }: { children: ReactNode }) {
  return <View style={styles.root}>{children}</View>;
}

export function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export function Stack({ children }: { children: ReactNode }) {
  return <View style={styles.inset}>{children}</View>;
}

export function UserMessage({ text }: { text: string }) {
  return (
    <View style={styles.userBubble}>
      <Text variant="bodySmall">{text}</Text>
    </View>
  );
}

export function Composer({ placeholder }: { placeholder: string }) {
  return (
    <View style={styles.composer}>
      <Text variant="body" tone="faint" style={styles.composerText}>
        {placeholder}
      </Text>
      <IconButton icon="mic" accessibilityLabel="Dictate" onPress={ignore} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  sources: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.spacing.md,
    rowGap: theme.spacing.xs,
  },
  columns: { flexDirection: 'row', gap: theme.spacing.lg },
  column: { flex: 1, gap: theme.spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.card,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    margin: theme.spacing.lg,
    paddingLeft: theme.spacing.md,
    minHeight: 48,
    backgroundColor: theme.colors.surfaceAlt,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.radius.control,
  },
  composerText: { flex: 1 },
  inset: { gap: theme.spacing.sm },
}));
