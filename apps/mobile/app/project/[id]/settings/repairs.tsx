import type { QAMode } from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../../../components/settings/SettingsChrome';
import { Text } from '../../../../components/ui';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam } from '../../../../lib/useProjectDetail';
import { useScanResource } from '../../../../lib/useScanResource';

const MODES: readonly { mode: QAMode; title: string; subtitle: string }[] = [
  {
    mode: 'automatic',
    title: 'Repair within mandate',
    subtitle: 'Default · the origin session first, otherwise a new one',
  },
  {
    mode: 'monitor',
    title: 'Observe and propose',
    subtitle: 'Report and suggest repairs, start nothing',
  },
  { mode: 'paused', title: 'Pause', subtitle: 'Keep issues, stop watching until resumed' },
];

/**
 * A project's QA (docs/ci-supervision.md): on by default once QA is switched on
 * in system settings; switching it off or changing its mode is project management.
 */
export default function ProjectRepairSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(async () => {
      if (!client || !projectId) throw new Error('Project unavailable.');
      return client.projectQA.state(projectId);
    }, [client, projectId]),
  );
  const state = resource.data;
  const choose = async (mode: QAMode) => {
    setSaving(true);
    try {
      await client!.projectQA.setMode(projectId, mode);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not change QA.');
    } finally {
      setSaving(false);
    }
  };
  const on = state?.mode !== undefined && state.mode !== null && state.mode !== 'off';
  const open = state?.issues.filter((i) => i.state === 'open' || i.state === 'needs_you').length;
  return (
    <SettingsScaffold
      title="QA"
      detail
      state={{ error: resource.error, saving }}
      onRetry={resource.reload}
    >
      <SettingsGroup
        title="QA"
        description="Watches pull requests and CI of this project and assigns repairs. It never merges, releases or deploys."
      >
        {state && !state.enabled ? (
          <Text variant="footnote">
            QA is switched off in system settings. An administrator turns it on there; it then runs
            in every coding project.
          </Text>
        ) : null}
        {state && !state.coding ? (
          <Text variant="footnote">QA only watches projects with a code repository.</Text>
        ) : null}
        <SettingsListPanel>
          <SettingsToggleRow
            label="QA for this project"
            subtitle="On by default from the system settings"
            value={on}
            // Opting out works ahead of time; opting in needs QA on in system settings.
            disabled={saving || !state?.coding || (!state.enabled && !on)}
            onValueChange={(value) => void choose(value ? 'automatic' : 'off')}
          />
          {on
            ? MODES.map((option) => (
                <SettingsChoiceRow
                  key={option.mode}
                  title={option.title}
                  subtitle={option.subtitle}
                  selected={state?.mode === option.mode}
                  disabled={saving}
                  onPress={() => void choose(option.mode)}
                />
              ))
            : null}
        </SettingsListPanel>
      </SettingsGroup>
      {on ? (
        <SettingsGroup title="Activity">
          <SettingsListPanel>
            <SettingsNavRow
              icon="shield"
              title="Open QA"
              subtitle={`${String(open ?? 0)} open ${open === 1 ? 'issue' : 'issues'}`}
              onPress={() =>
                router.push({ pathname: '/project/[id]/qa', params: { id: projectId } })
              }
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
    </SettingsScaffold>
  );
}
