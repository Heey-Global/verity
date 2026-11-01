import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { SettingsScaffold, SettingsGroup } from '../../../../components/settings/SettingsChrome';
import { Button, Text, Group } from '../../../../components/ui';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam } from '../../../../lib/useProjectDetail';
import { useScanResource } from '../../../../lib/useScanResource';

export default function ProjectRepairSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client || !projectId) throw new Error('Project unavailable.');
      return client.projectRepairs(projectId);
    }, [client, projectId]),
  );
  const choose = async (mode: 'off' | 'monitor' | 'automatic') => {
    setSaving(true);
    try {
      await client!.projectRepairs(projectId, mode);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not update QA access.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsScaffold
      title="QA · CI supervision"
      detail
      state={{ error: resource.error, saving }}
      onRetry={resource.reload}
    >
      <SettingsGroup title="Project access">
        <Text>{resource.data?.mandate?.mode ?? 'off'}</Text>
        {!resource.data?.qaEnabled ? (
          <Text variant="footnote">
            QA is disabled in system settings. Enable QA there before allowing monitoring or QA
            repairs here. Session PR repairs continue independently.
          </Text>
        ) : null}
        <Text variant="footnote">
          Off is the default: QA receives no new observations and cannot assign work in this
          project. Monitor allows observation only. Automatic repairs also allows QA to assign
          repairs for resources without an originating session, without asking each time. Session
          PRs repair automatically in their originating session in every QA mode. QA analyzes
          recurring failures across PRs to propose preventive improvements.
        </Text>
        <Group>
          <Button
            label="Off · no access"
            variant="secondary"
            disabled={saving || !resource.data}
            onPress={() => void choose('off')}
          />
          <Button
            label="Monitor only"
            variant="secondary"
            disabled={saving || !resource.data?.qaEnabled}
            onPress={() => void choose('monitor')}
          />
          <Button
            label="Allow automatic repairs"
            variant="secondary"
            disabled={saving || !resource.data?.qaEnabled}
            onPress={() => void choose('automatic')}
          />
        </Group>
        <Text variant="footnote">
          Turning access off stops new monitoring and assignments. Existing repair sessions keep
          their project permissions; open a running session to stop it. Merge, release and
          deployment are outside this standing instruction.
        </Text>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
