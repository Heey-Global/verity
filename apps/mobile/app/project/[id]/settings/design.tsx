// Design, per project: whether an accepted plan stops for mockups before the
// agent builds it. The agent learns the level when planning starts; the review
// itself happens in the session (components/session/MockupReview.tsx).
import { type ProjectDesignLevel, type VerityClient } from '@verity/mobile';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';

import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsScaffold,
} from '../../../../components/settings/SettingsChrome';
import { createVerityClient } from '../../../../lib/client';
import { DESIGN_LEVELS } from '../../../../lib/designLevels';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function ProjectDesignSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || !projectId) {
    return (
      <SettingsScaffold
        title="Design"
        detail
        state={{ error: 'Project unavailable.', saving: false }}
      >
        {null}
      </SettingsScaffold>
    );
  }
  return <ProjectDesignView client={client} projectId={projectId} />;
}

function ProjectDesignView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { detail, error, setError, load, onSettingsSaved } = useProjectDetail(client, projectId);
  // The level being saved, shown at once so the check mark moves on tap.
  const [pending, setPending] = useState<ProjectDesignLevel | undefined>(undefined);
  const stored = detail?.settings?.designLevel ?? 'on_request';
  const level = pending ?? stored;
  const choose = async (next: ProjectDesignLevel) => {
    if (pending !== undefined || next === stored) return;
    setPending(next);
    setError(undefined);
    try {
      onSettingsSaved(await client.updateProjectSettings(projectId, { designLevel: next }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the design setting');
    } finally {
      setPending(undefined);
    }
  };
  return (
    <SettingsScaffold
      title="Design"
      detail
      state={{ error, saving: pending !== undefined }}
      onRetry={() => load()}
    >
      <SettingsGroup
        title="Mockups"
        description="Mockups are shown after you approve a plan and before the agent builds it. You approve or discard each screen and tell the agent in the chat what to change and when to build. The agent builds them from the project's own components where it has them."
      >
        <SettingsListPanel>
          {DESIGN_LEVELS.map((entry) => (
            <SettingsChoiceRow
              key={entry.level}
              title={entry.title}
              subtitle={entry.subtitle}
              selected={detail !== undefined && level === entry.level}
              disabled={detail === undefined || pending !== undefined}
              onPress={() => void choose(entry.level)}
            />
          ))}
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
