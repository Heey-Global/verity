import { projectTitle, qaRowView } from '@verity/mobile';
import { router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Button, Row, Text } from '../../components/ui';
import type { StatusIntent } from '../../components/ui/Status';
import { createVerityClient } from '../../lib/client';
import { useScanResource } from '../../lib/useScanResource';

const ROW_STATUS: Record<string, { intent: StatusIntent; label: string }> = {
  needsYou: { intent: 'needsSetup', label: 'Needs you' },
  access: { intent: 'needsSetup', label: 'Check access' },
  working: { intent: 'transient', label: 'Working' },
  clear: { intent: 'ready', label: 'All clear' },
  paused: { intent: 'unknown', label: 'Paused' },
  off: { intent: 'unknown', label: 'Off' },
};

const MODE: Record<string, string> = {
  automatic: 'Repair within mandate',
  monitor: 'Observe and propose',
  paused: 'Paused',
  off: 'Switched off in the project',
};

/**
 * The system switch for QA (docs/ci-supervision.md): when on, every coding
 * project has its own QA, which projects can switch off. Administrators only.
 */
export default function RepairSettingsScreen() {
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client) throw new Error('Connect to a server first.');
      // Only administrators read the system switch; everyone else still sees projects.
      const [qa, projects] = await Promise.all([
        client.projectQA.settings().catch(() => null),
        client.listProjects(),
      ]);
      return { qa, projects: projects.filter((project) => project.qaSummary !== undefined) };
    }, [client]),
  );
  const act = async (work: () => Promise<unknown>) => {
    setSaving(true);
    try {
      await work();
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not change QA.');
    } finally {
      setSaving(false);
    }
  };
  const qa = resource.data?.qa;
  const value = (text: string) => <Text variant="bodySmall">{text}</Text>;
  return (
    <SettingsScaffold
      title="QA"
      detail
      state={{ error: resource.error, saving }}
      onRetry={resource.reload}
    >
      <SettingsGroup title="QA">
        {resource.data && !qa ? (
          <Text variant="footnote">Only administrators can switch QA on or off.</Text>
        ) : null}
        <SettingsListPanel>
          <SettingsToggleRow
            label="QA in coding projects"
            subtitle="Active in every project with a repository; projects can switch it off"
            value={qa?.enabled === true}
            disabled={saving || !qa}
            onValueChange={(enabled) => void act(() => client!.projectQA.settings(enabled))}
          />
        </SettingsListPanel>
      </SettingsGroup>
      {qa?.brakeAt ? (
        <SettingsGroup
          title="Emergency brake"
          description="Repairs started unusually fast, so QA stopped starting new ones everywhere. Running work continues. Check the projects below before releasing it."
        >
          <Button
            label="Release brake"
            disabled={saving}
            onPress={() => void act(() => client!.projectQA.releaseBrake())}
          />
        </SettingsGroup>
      ) : null}
      <SettingsGroup
        title="Mode and limits"
        description="New projects start in “Repair within mandate”. QA never merges, releases or deploys."
      >
        <SettingsListPanel>
          <Row title="Rework rounds per issue" trailing={value('2')} />
          <Row title="Parallel repairs per project" trailing={value('3, then queued')} />
          <Row
            title="Emergency brake"
            subtitle="Stops QA everywhere after 20 repair starts in an hour"
            trailing={value(qa?.brakeAt ? 'Engaged' : 'Ready')}
          />
        </SettingsListPanel>
      </SettingsGroup>
      {(qa?.enabled ?? true) && resource.data?.projects.length ? (
        <SettingsGroup title="Projects">
          <SettingsListPanel>
            {resource.data.projects.map((project) => {
              const view = qaRowView(project.qaSummary!);
              return (
                <SettingsNavRow
                  key={project.id}
                  icon="folder"
                  title={projectTitle(project)}
                  subtitle={MODE[project.qaSummary!.mode] ?? 'QA'}
                  status={ROW_STATUS[view.state]}
                  onPress={() =>
                    router.push({
                      pathname:
                        view.state === 'off'
                          ? '/project/[id]/settings/repairs'
                          : '/project/[id]/qa',
                      params: { id: project.id },
                    })
                  }
                />
              );
            })}
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
    </SettingsScaffold>
  );
}
