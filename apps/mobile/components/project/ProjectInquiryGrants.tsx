import { projectTitle, type VerityClient } from '@verity/mobile';
import { useCallback, useState } from 'react';
import { useScanResource } from '../../lib/useScanResource';
import { Button, Row, Text } from '../ui';
import { SettingsGroup, SettingsListPanel } from '../settings/SettingsChrome';

/**
 * The projects this project's sessions may ask without a card. A target only
 * gets here through "Always allow" on a request; revoking puts its questions
 * back behind a card. Without any target the section is not shown.
 */
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
  const [busy, setBusy] = useState<string>();
  const revoke = async (target: string) => {
    setBusy(target);
    try {
      await client.revokeInquiryGrant(projectId, target);
      resource.reload();
    } catch (error) {
      resource.setError(
        error instanceof Error ? error.message : 'Could not revoke the permission.',
      );
    } finally {
      setBusy(undefined);
    }
  };
  const allowed = (resource.data?.grants ?? []).filter((grant) => grant.enabled);
  if (allowed.length === 0 && !resource.error) return null;
  return (
    <SettingsGroup
      title="Allowed project inquiries"
      description="Sessions in this project may ask these projects questions without asking you first. Answers are read-only; changes always need your approval."
    >
      {resource.error ? <Text tone="attention">{resource.error}</Text> : null}
      {allowed.length > 0 ? (
        <SettingsListPanel>
          {allowed.map((grant) => {
            const project = resource.data?.projects.find((p) => p.id === grant.targetProjectId);
            const title = project ? projectTitle(project) : grant.targetProjectId;
            return (
              <Row
                key={grant.targetProjectId}
                leading={{ icon: 'folder' }}
                title={title}
                subtitle={`Always allowed since ${new Date(grant.createdAt).toLocaleDateString()}`}
                trailing={
                  <Button
                    label="Revoke"
                    size="compact"
                    variant="secondary"
                    accessibilityLabel={`Revoke questions to ${title}`}
                    loading={busy === grant.targetProjectId}
                    disabled={busy !== undefined}
                    onPress={() => void revoke(grant.targetProjectId)}
                  />
                }
              />
            );
          })}
        </SettingsListPanel>
      ) : null}
    </SettingsGroup>
  );
}
