import {
  pullRequestAction,
  pullRequestCounts,
  pullRequestSummary,
  type ProjectPullRequest,
  type RepositoryPullRequests,
  type VerityClient,
} from '@verity/mobile';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { checksLine, pullRequestOrigin, pullRequestTag } from '../../lib/projectRepositories';
import { useProjectPullRequests } from '../../lib/useProjectPullRequests';
import { CodeHostIcon } from '../CodeHostIcon';
import {
  Button,
  CardHead,
  Group,
  HintBox,
  IconButton,
  Row,
  Sheet,
  StatusTag,
  Text,
  useConfirm,
} from '../ui';

const hostName = (repository: RepositoryPullRequests) =>
  repository.kind === 'github' ? 'GitHub' : 'Forgejo';

function openUrl(url: string | null) {
  if (url) void Linking.openURL(url).catch(() => undefined);
}

function openSession(sessionId: string) {
  router.push({ pathname: '/session/[id]', params: { id: sessionId } });
}

/**
 * Every repository of a project as a heading, its open pull requests below it,
 * conflicts and failures first. A green pull request merges right here, a failing
 * one without a session gets one; tapping a row shows its details.
 */
export function RepositoriesPage({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const { theme } = useUnistyles();
  const { repositories, error, reload } = useProjectPullRequests(client, projectId);
  const [refreshing, setRefreshing] = useState(false);
  const [opened, setOpened] = useState<{
    repository: RepositoryPullRequests;
    pull: ProjectPullRequest;
  }>();
  const [fixing, setFixing] = useState<string>();
  const [confirm, confirmSheet] = useConfirm();

  const refresh = () => {
    setRefreshing(true);
    void reload(true).finally(() => setRefreshing(false));
  };

  const merge = (repository: RepositoryPullRequests, pull: ProjectPullRequest) => {
    setOpened(undefined);
    confirm({
      title: `Merge PR #${String(pull.number)}?`,
      message: `Merges “${pull.title}” into ${pull.baseRef ?? 'its base branch'} at commit ${pull.headSha.slice(0, 7)}. If the branch changes before then, nothing is merged.`,
      confirmLabel: 'Merge',
      onConfirm: async () => {
        try {
          // A session's own pull request merges through the session, which also
          // settles its worktree afterwards.
          // Either way only the confirmed commit merges.
          if (pull.origin.kind === 'session')
            await client.mergePullRequest(pull.origin.sessionId, pull.number, pull.headSha);
          else
            await client.mergeProjectPullRequest(projectId, repository.id, pull.number, {
              branch: pull.branch,
              expectedHeadSha: pull.headSha,
            });
        } catch (caught) {
          Alert.alert(
            'Not merged',
            caught instanceof Error ? caught.message : 'The pull request could not be merged.',
          );
        }
        void reload(true);
      },
    });
  };

  const fix = async (repository: RepositoryPullRequests, pull: ProjectPullRequest) => {
    const key = `${repository.id}#${String(pull.number)}`;
    if (fixing !== undefined) return;
    setFixing(key);
    try {
      const started = await client.fixProjectPullRequest(
        projectId,
        repository.id,
        pull.number,
        pull.branch,
      );
      setOpened(undefined);
      void reload(true);
      openSession(started.sessionId);
    } catch (caught) {
      Alert.alert(
        'No fix session started',
        caught instanceof Error ? caught.message : 'The session could not be started.',
      );
    } finally {
      setFixing(undefined);
    }
  };

  let body;
  if (repositories === undefined) {
    body = error ? (
      <HintBox title="Couldn't load pull requests" message={error}>
        <Button label="Retry" variant="secondary" size="compact" onPress={() => void reload()} />
      </HintBox>
    ) : (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.colors.text} />
      </View>
    );
  } else if (repositories.length === 0) {
    body = (
      <Text variant="bodySmall" tone="muted">
        This project has no repository on a code host.
      </Text>
    );
  } else {
    body = repositories.map((repository) => (
      <RepositorySection
        key={repository.id}
        repository={repository}
        fixing={fixing}
        onOpen={(pull) => setOpened({ repository, pull })}
        onMerge={(pull) => merge(repository, pull)}
        onFix={(pull) => void fix(repository, pull)}
        onRetry={refresh}
      />
    ));
  }

  return (
    <View style={styles.root} testID="project-repositories">
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {body}
      </ScrollView>
      {opened ? (
        <PullRequestSheet
          repository={opened.repository}
          pull={opened.pull}
          fixing={fixing === `${opened.repository.id}#${String(opened.pull.number)}`}
          onClose={() => setOpened(undefined)}
          onMerge={() => merge(opened.repository, opened.pull)}
          onFix={() => void fix(opened.repository, opened.pull)}
        />
      ) : null}
      {confirmSheet}
    </View>
  );
}

function RepositorySection({
  repository,
  fixing,
  onOpen,
  onMerge,
  onFix,
  onRetry,
}: {
  repository: RepositoryPullRequests;
  fixing: string | undefined;
  onOpen: (pull: ProjectPullRequest) => void;
  onMerge: (pull: ProjectPullRequest) => void;
  onFix: (pull: ProjectPullRequest) => void;
  onRetry: () => void;
}) {
  const { theme } = useUnistyles();
  const host = hostName(repository);
  const unavailable = repository.status === 'unavailable';
  return (
    <View style={styles.section} testID={`repository-${repository.id}`}>
      <CardHead
        leading={{
          element: <CodeHostIcon provider={repository.kind} color={theme.colors.action} />,
        }}
        title={repository.name}
        subtitle={
          unavailable
            ? `${host} did not answer`
            : `${host} · ${pullRequestSummary(pullRequestCounts(repository.pullRequests))}`
        }
        trailing={
          unavailable ? (
            <StatusTag intent="unknown" label="Unavailable" />
          ) : (
            <IconButton
              icon="external-link"
              accessibilityLabel={`Open ${repository.name} on ${host}`}
              onPress={() => openUrl(repository.webUrl)}
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
                onPress={onRetry}
              />,
            ]
          : repository.pullRequests.length === 0
            ? [<Row key="none" title="No open pull requests" />]
            : repository.pullRequests.map((pull) => {
                const tag = pullRequestTag(pull.state);
                const action = pullRequestAction(pull);
                const busy = fixing === `${repository.id}#${String(pull.number)}`;
                return (
                  <Row
                    key={pull.number}
                    title={pull.title}
                    subtitle={`#${String(pull.number)} · ${pullRequestOrigin(pull)}`}
                    trailing={<StatusTag intent={tag.intent} label={tag.label} />}
                    navigates
                    onPress={() => onOpen(pull)}
                    answers={
                      action === 'merge' ? (
                        <Button label="Merge" size="small" onPress={() => onMerge(pull)} />
                      ) : action === 'fix' ? (
                        <Button
                          label="Fix"
                          size="small"
                          loading={busy}
                          disabled={fixing !== undefined && !busy}
                          onPress={() => onFix(pull)}
                        />
                      ) : undefined
                    }
                  />
                );
              })}
      </Group>
    </View>
  );
}

function PullRequestSheet({
  repository,
  pull,
  fixing,
  onClose,
  onMerge,
  onFix,
}: {
  repository: RepositoryPullRequests;
  pull: ProjectPullRequest;
  fixing: boolean;
  onClose: () => void;
  onMerge: () => void;
  onFix: () => void;
}) {
  const tag = pullRequestTag(pull.state);
  const action = pullRequestAction(pull);
  const failing = pull.state === 'failing' || pull.state === 'conflict';
  const origin = pull.origin;
  return (
    <Sheet
      visible
      title={`PR #${String(pull.number)}`}
      onClose={onClose}
      footer={
        action === 'merge' ? (
          <Button label="Merge" onPress={onMerge} fullWidth />
        ) : action === 'fix' ? (
          <Button label="Fix in new session" loading={fixing} onPress={onFix} fullWidth />
        ) : undefined
      }
    >
      <Text variant="row">{pull.title}</Text>
      <Text variant="footnote" tone="muted">
        {`${repository.name} · ${pull.branch} → ${pull.baseRef ?? 'base'} · ${pullRequestOrigin(pull)}`}
      </Text>
      <Group>
        <Row
          leading={{
            dot: failing ? 'needsSetup' : pull.state === 'ready' ? 'ready' : 'unknown',
          }}
          title={checksLine(pull)}
          subtitle={`Head ${pull.headSha.slice(0, 7)}`}
          trailing={<StatusTag intent={tag.intent} label={tag.label} />}
        />
        {origin.kind === 'session' ? (
          <Row
            leading={{ icon: 'message-square' }}
            title="Open session"
            subtitle={origin.name ?? undefined}
            navigates
            onPress={() => {
              onClose();
              openSession(origin.sessionId);
            }}
          />
        ) : null}
        {pull.url ? (
          <Row
            leading={{ icon: 'external-link' }}
            title={`Open on ${hostName(repository)}`}
            navigates
            onPress={() => openUrl(pull.url)}
          />
        ) : null}
      </Group>
      {action === 'fix' ? (
        <Text variant="footnote" tone="muted">
          {`A new session starts on ${pull.branch} with the ${pull.state === 'conflict' ? 'conflict' : 'failed checks'} as its first task. The pull request then shows that session.`}
        </Text>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.lg },
  section: { gap: theme.spacing.sm },
  centered: { paddingVertical: theme.spacing.xl, alignItems: 'center' },
}));
