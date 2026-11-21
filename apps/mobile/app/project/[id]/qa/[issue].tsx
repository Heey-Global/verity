import { projectTitle, type VerityClient } from '@verity/mobile';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { QAIssueDetail } from '../../../../components/project/ProjectQAPage';
import { Text } from '../../../../components/ui';
import { SettingsMessage } from '../../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';
import { useProjectQA } from '../../../../lib/useProjectQA';

/** One QA issue: why QA stopped, the answers, its timeline and evidence. */
export default function ProjectQAIssueScreen() {
  const params = useLocalSearchParams<{ id: string | string[]; issue: string }>();
  const projectId = projectIdParam(params.id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) return <Unavailable />;
  return <ProjectQAIssueView client={client} projectId={projectId} issueId={params.issue} />;
}

function ProjectQAIssueView({
  client,
  projectId,
  issueId,
}: {
  client: VerityClient;
  projectId: string;
  issueId: string;
}) {
  const { theme } = useUnistyles();
  const { detail } = useProjectDetail(client, projectId);
  const qa = useProjectQA(client, projectId, true);
  const issue = qa.state?.issues.find((row) => row.id === issueId);
  return (
    <View style={styles.root} testID="project-qa-issue">
      <Stack.Screen options={{ title: issue ? 'QA issue' : 'QA' }} />
      {qa.state === undefined ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.text} />
        </View>
      ) : !issue ? (
        <View style={styles.centered}>
          <Text variant="body" tone="muted">
            This issue is no longer tracked.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <QAIssueDetail
            issue={issue}
            projectName={detail ? projectTitle(detail.project) : 'Project'}
            canDecide
            onDecide={async (decision) => {
              qa.setState(await client.projectQA.decide(projectId, issue.id, decision));
            }}
            onOpenSession={(sessionId) =>
              router.push({ pathname: '/session/[id]', params: { id: sessionId } })
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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
}));
