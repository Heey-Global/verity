import { projectTitle, type VerityClient } from '@verity/mobile';
import { useCallback, useState } from 'react';
import { useScanResource } from '../../lib/useScanResource';
import { Card, Text, ToggleRow } from '../ui';
import { SettingsGroup } from '../settings/SettingsChrome';

export function ProjectInquiryGrants({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const resource = useScanResource(
    useCallback(async () => {
      const [projects, grants] = await Promise.all([
        client.listProjects(),
        client.listInquiryGrants(projectId),
      ]);
      return { projects, grants };
    }, [client, projectId]),
  );
  const [busy, setBusy] = useState(false);
  const choose = async (target: string, enabled: boolean) => {
    setBusy(true);
    try {
      await client.setInquiryGrant(projectId, target, enabled);
      resource.reload();
    } catch (error) {
      resource.setError(
        error instanceof Error ? error.message : 'Could not update project access.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsGroup
      title="Project inquiries"
      description="Allow sessions in this project to ask these projects automatically. Changes requested there require human approval in the target project."
    >
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      {resource.data?.projects
        .filter((p) => p.id !== projectId && p.archived !== true && p.kind !== 'control_plane')
        .map((project) => (
          <Card flush key={project.id}>
            <ToggleRow
              title={projectTitle(project)}
              value={
                resource.data?.grants.some((g) => g.targetProjectId === project.id && g.enabled) ??
                false
              }
              disabled={busy}
              onValueChange={(value) => void choose(project.id, value)}
            />
          </Card>
        ))}
    </SettingsGroup>
  );
}
