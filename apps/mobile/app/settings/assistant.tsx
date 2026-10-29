import { useCallback, useMemo, useState } from 'react';
import { router } from 'expo-router';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Row } from '../../components/ui';
import { createVerityClient } from '../../lib/client';
import { useScanResource } from '../../lib/useScanResource';

const MODE_LABEL = { tasks: 'Tasks only', delegate: 'Tasks and sessions' } as const;

/** System settings of the Verity assistant: one Verity Control session that files work into
 *  the projects granted to it (docs/assistant.md). */
export default function AssistantSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client) throw new Error('Connect to a server first.');
      const [settings, projects] = await Promise.all([
        client.assistantSettings(),
        client.listProjects(),
      ]);
      return { settings, projects };
    }, [client]),
  );
  const settings = resource.data?.settings;
  const projects = resource.data?.projects ?? [];
  const control = projects.find((project) => project.kind === 'control_plane');
  const granted = (settings?.grants ?? []).flatMap((grant) => {
    const project = projects.find((candidate) => candidate.id === grant.projectId);
    return project && grant.mode !== 'off' ? [{ project, mode: grant.mode }] : [];
  });
  const setEnabled = async (enabled: boolean) => {
    setSaving(true);
    try {
      await client!.assistantSettings(enabled);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not update the assistant.');
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
        title="Verity assistant"
        description="Talk to Verity by voice note or chat. It files tasks into the projects you grant and can hand work to their sessions. Sending mail and changing events always need your approval."
      >
        <SettingsListPanel>
          <SettingsToggleRow
            label="Assistant"
            subtitle="Runs as a session in Verity Control"
            value={settings?.enabled ?? false}
            disabled={saving || settings === undefined}
            onValueChange={(value) => void setEnabled(value)}
          />
          {settings?.sessionId ? (
            <SettingsNavRow
              icon="message-circle"
              title="Open assistant"
              onPress={() => router.push(`/session/${settings.sessionId}`)}
            />
          ) : null}
          {control ? (
            <SettingsNavRow
              icon="mail"
              title="Mail and calendar"
              subtitle="Google accounts of Verity Control"
              onPress={() => router.push(`/project/${control.id}/settings/services?section=google`)}
            />
          ) : null}
        </SettingsListPanel>
      </SettingsGroup>
      <SettingsGroup
        title="Project access"
        description="Off by default. Grant access in each project's Agents settings."
      >
        <SettingsListPanel>
          {granted.length === 0 ? (
            <Row title="No projects granted" subtitle="Open a project's settings to grant access" />
          ) : (
            granted.map(({ project, mode }) => (
              <SettingsNavRow
                key={project.id}
                icon="folder"
                title={`${project.owner}/${project.repo}`}
                value={MODE_LABEL[mode]}
                onPress={() => router.push(`/project/${project.id}/settings/assistant`)}
              />
            ))
          )}
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
