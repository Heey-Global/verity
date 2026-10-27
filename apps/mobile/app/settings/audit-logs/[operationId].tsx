// One audit operation: who started it, what it was built from, what it produced.
// Fingerprints and stream positions stay in the Server's records; only what
// answers those three questions is shown (ADR 0028, "Presentation").
import type { AuditOperationDetail, VerityClient } from '@verity/mobile';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsScaffold,
} from '../../../components/settings/SettingsChrome';
import { Row, StatusTag, Text } from '../../../components/ui';
import type { StatusIntent } from '../../../components/ui/Status';
import {
  auditDate,
  auditInitiatorLabel,
  auditTime,
  auditTitle,
  formatBytes,
  shortDigest,
} from '../../../lib/auditLabels';
import { createVerityClient } from '../../../lib/client';

const OUTCOME: Record<AuditOperationDetail['status'], { intent: StatusIntent; label: string }> = {
  succeeded: { intent: 'ready', label: 'Succeeded' },
  failed: { intent: 'needsSetup', label: 'Failed' },
  running: { intent: 'transient', label: 'Running' },
  unknown: { intent: 'unknown', label: 'Unknown' },
  recorded: { intent: 'ready', label: 'Recorded' },
};

export default function AuditOperationScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const { operationId } = useLocalSearchParams<{ operationId?: string }>();
  if (!client || typeof operationId !== 'string') {
    return <SettingsMessage title="Entry unavailable" subtitle="Go back and open it again." />;
  }
  return <AuditOperationView client={client} operationId={operationId} />;
}

export function AuditOperationView({
  client,
  operationId,
}: {
  client: VerityClient;
  operationId: string;
}) {
  const [operation, setOperation] = useState<AuditOperationDetail | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    setError(undefined);
    client
      .auditOperation(operationId)
      .then(setOperation)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Could not load this entry.'),
      );
  }, [client, operationId]);
  useEffect(load, [load]);

  if (operation === undefined) {
    return (
      <SettingsScaffold title="Audit log" detail state={{ error, saving: false }} onRetry={load}>
        {error === undefined ? <Text tone="muted">Loading…</Text> : null}
      </SettingsScaffold>
    );
  }

  const outcome = OUTCOME[operation.status];
  const build = operation.build;
  const range =
    operation.finishedAt !== null && operation.finishedAt !== operation.startedAt
      ? `${auditTime(operation.startedAt)}–${auditTime(operation.finishedAt)}`
      : auditTime(operation.startedAt);
  const session = operation.initiator.kind === 'session' ? operation.initiator : undefined;
  const project = operation.project;

  return (
    <SettingsScaffold title={auditTitle(operation)} detail state={{ error, saving: false }}>
      <View style={styles.head}>
        <StatusTag intent={outcome.intent} label={outcome.label} />
        <Text variant="footnote" tone="faint">
          {auditDate(operation.startedAt)} · {range}
        </Text>
      </View>

      <SettingsGroup title="Started by">
        <SettingsListPanel>
          {session === undefined ? (
            <Row title="Initiator" subtitle={auditInitiatorLabel(operation.initiator)} />
          ) : session.name !== null ? (
            <Row
              title="Session"
              subtitle={session.name}
              navigates
              onPress={() =>
                router.push(`/session/${encodeURIComponent(session.sessionId)}` as Href)
              }
            />
          ) : (
            // The session is gone; only its record remains, so there is nothing to open.
            <Row title="Session" subtitle="Deleted session" />
          )}
          {project === null ? null : operation.kind === 'project_deleted' ? (
            <Row title="Project" subtitle={project.label ?? project.id} />
          ) : (
            <Row
              title="Project"
              subtitle={project.label ?? project.id}
              navigates
              onPress={() => router.push(`/project/${encodeURIComponent(project.id)}` as Href)}
            />
          )}
        </SettingsListPanel>
      </SettingsGroup>

      {build !== null ? (
        <SettingsGroup title="Source">
          <SettingsListPanel>
            <Row title="Commit" subtitle={build.commit?.slice(0, 7) ?? 'Not recorded'} />
            <Row
              title="Base image"
              subtitle={
                build.baseImageDigest !== null
                  ? `${build.baseImageRef} · ${shortDigest(build.baseImageDigest)}`
                  : build.baseImageRef
              }
            />
            {build.features.map((feature) => (
              <Row key={feature} title="Feature" subtitle={feature} />
            ))}
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}

      {operation.imageId !== null || operation.imageRef !== null ? (
        <SettingsGroup title="Result">
          <SettingsListPanel>
            <Row
              title="Image"
              subtitle={[
                operation.imageRef,
                operation.imageId !== null ? shortDigest(operation.imageId) : null,
                build?.sizeBytes != null ? formatBytes(build.sizeBytes) : null,
              ]
                .filter((part): part is string => part !== null && part !== undefined)
                .join(' · ')}
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}

      {operation.gapWindow !== null ? (
        <SettingsGroup title="Missing entries">
          <SettingsListPanel>
            <Row
              title="Not recorded"
              subtitle={`${operation.failedWrites ?? 0} between ${auditTime(operation.gapWindow.from)} and ${auditTime(operation.gapWindow.to)}`}
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Server">
        <SettingsListPanel>
          <Row
            title="Version"
            subtitle={
              operation.server.generation !== null
                ? `${operation.server.release} · generation ${operation.server.generation}`
                : operation.server.release
            }
          />
        </SettingsListPanel>
      </SettingsGroup>

      <SettingsGroup title="Entry">
        <SettingsListPanel>
          <Row
            leading={{ icon: 'copy' }}
            title="Copy ID"
            subtitle={operation.operationId}
            onPress={() => void Clipboard.setStringAsync(operation.operationId)}
            accessibilityLabel="Copy entry ID"
          />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
}));
