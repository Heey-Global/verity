import type { CodeHostProvider } from '@verity/mobile';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeHostIcon } from '../../components/CodeHostIcon';
import {
  Button,
  CardHead,
  Group,
  IconButton,
  Row,
  Sheet,
  StatusTag,
  Text,
} from '../../components/ui';
import { tint } from '../../components/ui/tint';

const ignore = () => undefined;

/** Sample data only: what the server's per-repository pull request list returns. */
export type PullState = 'conflict' | 'failing' | 'running' | 'ready';
export type PullOrigin =
  { kind: 'session'; title: string } | { kind: 'renovate' } | { kind: 'external'; author: string };

export interface SamplePull {
  number: number;
  title: string;
  branch: string;
  state: PullState;
  origin: PullOrigin;
  checks: string;
}

export interface SampleRepository {
  provider: CodeHostProvider;
  name: string;
  host: string;
  pulls: readonly SamplePull[] | 'unavailable';
}

export const VERITY_PULLS: readonly SamplePull[] = [
  {
    number: 2401,
    title: 'fix(deps): update dependency expo to v57',
    branch: 'renovate/expo-57.x',
    state: 'conflict',
    origin: { kind: 'renovate' },
    checks: 'Conflicts with main',
  },
  {
    number: 2398,
    title: 'fix(deps): update dependency sigstore to v5.1.0',
    branch: 'renovate/sigstore-5.x',
    state: 'failing',
    origin: { kind: 'renovate' },
    checks: '2 of 14 checks failed',
  },
  {
    number: 2394,
    title: 'Stable session order',
    branch: 'agent/7f31c0aa',
    state: 'failing',
    origin: { kind: 'session', title: 'Stabile Session Sortierung' },
    checks: '1 of 14 checks failed',
  },
  {
    number: 2403,
    title: 'Reduce the task list',
    branch: 'agent/5c2e81d0',
    state: 'running',
    origin: { kind: 'session', title: 'Aufgabenliste Reduzieren' },
    checks: '9 of 14 checks done',
  },
  {
    number: 2399,
    title: 'fix(deps): update dependency graphql to v17.1.0',
    branch: 'renovate/graphql-17.x',
    state: 'ready',
    origin: { kind: 'renovate' },
    checks: '14 checks passed',
  },
  {
    number: 2390,
    title: 'docs: clarify Forgejo token scopes',
    branch: 'docs/forgejo-scopes',
    state: 'ready',
    origin: { kind: 'external', author: 'mkrause' },
    checks: '14 checks passed',
  },
];

export const VERITY: SampleRepository = {
  provider: 'github',
  name: 'heey-global/verity',
  host: 'GitHub',
  pulls: VERITY_PULLS,
};

export const WEBSITE: SampleRepository = {
  provider: 'github',
  name: 'heey-global/verity-website',
  host: 'GitHub',
  pulls: [
    {
      number: 88,
      title: 'chore(deps): update astro to v6.2',
      branch: 'renovate/astro-6.x',
      state: 'ready',
      origin: { kind: 'renovate' },
      checks: '4 checks passed',
    },
  ],
};

export const INFRA: SampleRepository = {
  provider: 'forgejo',
  name: 'ops/verity-infra',
  host: 'git.heey.dev',
  pulls: 'unavailable',
};

const STATE_TAG: Record<
  PullState,
  { intent: 'needsSetup' | 'transient' | 'ready'; label: string }
> = {
  conflict: { intent: 'needsSetup', label: 'Conflict' },
  failing: { intent: 'needsSetup', label: 'Failing' },
  running: { intent: 'transient', label: 'Running' },
  ready: { intent: 'ready', label: 'Ready' },
};

export function originLabel(origin: PullOrigin): string {
  if (origin.kind === 'session') return `Session · ${origin.title}`;
  if (origin.kind === 'renovate') return 'Renovate';
  return `External · ${origin.author}`;
}

/** "6 open · 2 failing · 1 conflict": failing and conflict only when present. */
export function pullSummary(pulls: readonly SamplePull[]): string {
  const count = (state: PullState) => pulls.filter((pull) => pull.state === state).length;
  const parts = [`${String(pulls.length)} open`];
  if (count('failing') > 0) parts.push(`${String(count('failing'))} failing`);
  if (count('conflict') > 0)
    parts.push(count('conflict') === 1 ? '1 conflict' : `${String(count('conflict'))} conflicts`);
  return parts.join(' · ');
}

/** One open pull request: what it is, where it came from, and whether it is green. */
export function PullRow({ pull, onPress }: { pull: SamplePull; onPress?: () => void }) {
  const tag = STATE_TAG[pull.state];
  return (
    <Row
      title={pull.title}
      subtitle={`#${String(pull.number)} · ${originLabel(pull.origin)}`}
      trailing={<StatusTag intent={tag.intent} label={tag.label} />}
      navigates
      onPress={onPress ?? ignore}
      answers={
        pull.state === 'ready' ? (
          <Button label="Merge" size="small" onPress={ignore} />
        ) : pull.origin.kind !== 'session' && pull.state !== 'running' ? (
          <Button label="Fix" size="small" onPress={ignore} />
        ) : undefined
      }
    />
  );
}

/** A repository as a heading on the page, its open pull requests in the box below. */
export function RepositorySection({ repository }: { repository: SampleRepository }) {
  const { theme } = useUnistyles();
  const pulls = repository.pulls;
  const unavailable = pulls === 'unavailable';
  return (
    <View style={styles.section}>
      <CardHead
        leading={{
          element: <CodeHostIcon provider={repository.provider} color={theme.colors.action} />,
        }}
        title={repository.name}
        subtitle={
          unavailable
            ? `${repository.host} did not answer · checked 2 min ago`
            : `${repository.host} · ${pullSummary(pulls)}`
        }
        trailing={
          unavailable ? (
            <StatusTag intent="unknown" label="Unavailable" />
          ) : (
            <IconButton
              icon="external-link"
              accessibilityLabel={`Open ${repository.name} on ${repository.host}`}
              onPress={ignore}
            />
          )
        }
      />
      <Group>
        {unavailable
          ? [
              <Row
                key="retry"
                leading={{ icon: 'refresh-cw', quiet: true }}
                title="Try again"
                subtitle="The other repositories are not affected"
                onPress={ignore}
              />,
            ]
          : pulls.length === 0
            ? [<Row key="none" title="No open pull requests" />]
            : pulls.map((pull) => <PullRow key={pull.number} pull={pull} />)}
      </Group>
    </View>
  );
}

/** The Repositories page: every connected repository with its pull requests. */
export function RepositoriesPage({
  repositories,
  sheet,
}: {
  repositories: readonly SampleRepository[];
  sheet?: ReactNode;
}) {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        {repositories.map((repository) => (
          <RepositorySection key={repository.name} repository={repository} />
        ))}
      </ScrollView>
      {sheet}
    </View>
  );
}

/** The sheet behind a pull request row: its state, then the action that fits it. */
export function PullSheet({
  pull,
  repository,
  primary,
}: {
  pull: SamplePull;
  repository: SampleRepository;
  primary: { label: string };
}) {
  const tag = STATE_TAG[pull.state];
  const failing = pull.state === 'failing' || pull.state === 'conflict';
  return (
    <Sheet
      visible
      title={`PR #${String(pull.number)}`}
      onClose={ignore}
      footer={<Button label={primary.label} onPress={ignore} fullWidth />}
    >
      <Text variant="row">{pull.title}</Text>
      <Text variant="footnote" tone="muted">
        {`${repository.name} · ${pull.branch} → main · ${originLabel(pull.origin)}`}
      </Text>
      <Group>
        <Row
          leading={failing ? { dot: 'needsSetup' } : { dot: 'ready' }}
          title={pull.checks}
          subtitle={
            pull.state === 'failing'
              ? 'test (packages/server) · lint (mobile)'
              : pull.state === 'conflict'
                ? 'package-lock.json, apps/mobile/package.json'
                : 'Mergeable · head 4f2c9a1'
          }
          trailing={<StatusTag intent={tag.intent} label={tag.label} />}
        />
        {pull.origin.kind === 'session' ? (
          <Row
            leading={{ icon: 'message-square' }}
            title="Open session"
            subtitle={pull.origin.title}
            navigates
            onPress={ignore}
          />
        ) : null}
        <Row
          leading={{ icon: 'external-link' }}
          title={`Open on ${repository.host}`}
          navigates
          onPress={ignore}
        />
      </Group>
      {failing && pull.origin.kind !== 'session' ? (
        <Text variant="footnote" tone="muted">
          A new session starts on {pull.branch} with the failed checks as its first task. The pull
          request then shows that session.
        </Text>
      ) : null}
    </Sheet>
  );
}

/** The project's head: its description instead of code host details. */
export function ProjectHeroSample({ line }: { line: string }) {
  return (
    <View style={styles.hero}>
      <View style={styles.initial}>
        <Text variant="title" tone="action">
          V
        </Text>
      </View>
      <View style={styles.flex}>
        <Text variant="title" accessibilityRole="header" numberOfLines={1}>
          verity
        </Text>
        <Text variant="subtitle" numberOfLines={2}>
          {line}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  section: { gap: theme.spacing.sm },
  flex: { flex: 1 },
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  initial: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tint(theme.colors.action, 'fill'),
  },
}));
