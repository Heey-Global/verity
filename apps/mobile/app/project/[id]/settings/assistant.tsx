import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam } from '../../../../lib/useProjectDetail';
import { useScanResource } from '../../../../lib/useScanResource';

type Mode = 'off' | 'tasks' | 'delegate';

const MODES: readonly { mode: Mode; title: string; subtitle: string }[] = [
  { mode: 'off', title: 'Off · no access', subtitle: 'The assistant cannot act in this project' },
  { mode: 'tasks', title: 'Tasks only', subtitle: 'Files tasks into this project’s backlog' },
  {
    mode: 'delegate',
    title: 'Tasks and sessions',
    subtitle: 'Also hands work to this project’s sessions',
  },
];

/** What the Verity assistant may do in one project (docs/assistant.md). */
export default function ProjectAssistantSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client || !projectId) throw new Error('Project unavailable.');
      return client.projectAssistant(projectId);
    }, [client, projectId]),
  );
  const enabled = resource.data?.assistantEnabled === true;
  const choose = async (mode: Mode) => {
    if (!client || !projectId) return;
    setSaving(true);
    try {
      await client.projectAssistant(projectId, mode);
      resource.reload();
    } catch (error) {
      resource.setError(
        error instanceof Error ? error.message : 'Could not update assistant access.',
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsScaffold
      title="Assistant"
      detail
      state={{ error: resource.error, saving }}
      onRetry={resource.reload}
    >
      <SettingsGroup
        title="Project access"
        description={
          enabled
            ? 'Work the assistant starts here runs with your permissions in this project.'
            : 'The assistant is off in system settings. Turn it on there before granting access.'
        }
      >
        <SettingsListPanel>
          {MODES.map(({ mode, title, subtitle }) => (
            <SettingsChoiceRow
              key={mode}
              title={title}
              subtitle={subtitle}
              selected={resource.data?.mode === mode}
              disabled={saving || resource.data === undefined || (mode !== 'off' && !enabled)}
              onPress={() => void choose(mode)}
            />
          ))}
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
