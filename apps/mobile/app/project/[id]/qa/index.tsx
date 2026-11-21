import { projectTitle, type VerityClient } from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { QAIssueList, QAStatusCard, QATabs } from '../../../../components/project/ProjectQAPage';
import { Button, Text } from '../../../../components/ui';
import { SettingsMessage } from '../../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';
import { useProjectQA } from '../../../../lib/useProjectQA';

/**
 * A project's QA role (docs/ci-supervision.md): what it watches and the issues
 * it tracks, without a composer. Chat opens the QA's own session.
 */
export default function ProjectQAScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) return <Unavailable />;
  return <ProjectQAView client={client} projectId={projectId} />;
}

function ProjectQAView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { theme } = useUnistyles();
  const { detail } = useProjectDetail(client, projectId);
  const qa = useProjectQA(client, projectId, true);
  const name = detail ? projectTitle(detail.project) : 'project';
  const state = qa.state;
  const open = state?.issues.filter((i) => i.state === 'open' || i.state === 'needs_you') ?? [];
  return (
    <View style={styles.root} testID="project-qa">
      <Stack.Screen options={{ title: `QA · ${name}` }} />
      {state === undefined ? (
        <View style={styles.centered}>
          {qa.error ? (
            <>
              <Text variant="body" tone="muted">
                {qa.error}
              </Text>
              <Button label="Retry" variant="secondary" size="compact" onPress={qa.reload} />
            </>
          ) : (
            <ActivityIndicator color={theme.colors.text} />
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={false} onRefresh={qa.reload} />}
        >
          <QAStatusCard state={state} name={name} />
          <QATabs
            value="issues"
            count={open.length}
            onChange={(value) => {
              if (value === 'chat' && state.sessionId)
                router.push({ pathname: '/session/[id]', params: { id: state.sessionId } });
            }}
          />
          {state.sessionId === null ? (
            <Text variant="footnote" tone="faint">
              The QA chat opens after QA's first review of this project.
            </Text>
          ) : null}
          <QAIssueList
            issues={state.issues}
            onOpen={(issue) =>
              router.push({
                pathname: '/project/[id]/qa/[issue]',
                params: { id: projectId, issue: issue.id },
              })
            }
          />
        </ScrollView>
      )}
    </View>
  );
}

function Unavailable() {
  return (
    <SettingsMessage
      title="Project unavailable"
      subtitle="This project could not be opened. Go back and pick it again."
      screenTitle="QA"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing.lg, gap: theme.spacing.sm },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md },
}));
