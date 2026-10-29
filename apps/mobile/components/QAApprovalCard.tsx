import { useCallback, useState } from 'react';
import type { VerityClient } from '@verity/mobile';
import { Card, Text, Button, Group } from './ui';
import { useScanResource } from '../lib/useScanResource';

/** Consent changes a standing project mandate, never just the current incident. */
export function QAApprovalCard({ client, sessionId }: { client: VerityClient; sessionId: string }) {
  const [saving, setSaving] = useState(false);
  const resource = useScanResource(
    useCallback(() => client.qaApprovals(sessionId), [client, sessionId]),
  );
  const proposal = resource.data?.proposals[0];
  if (!proposal) return null;
  const decide = async (allow: boolean) => {
    setSaving(true);
    try {
      await client.decideQAApproval(proposal.project_id, proposal.id, allow);
      resource.reload();
    } catch (error) {
      resource.setError(error instanceof Error ? error.message : 'Could not save your decision.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card stacked attention>
      <Text>
        QA found a failure in {proposal.owner}/{proposal.repo} · {proposal.resource}
      </Text>
      <Text variant="footnote">
        Allow Verity to repair this project automatically? This changes the project to Automatic
        repairs and also permits future repairs. Merge, release and deployment remain outside this
        permission.
      </Text>
      {resource.error ? <Text>{resource.error}</Text> : null}
      <Group>
        <Button
          label="Allow automatic repairs for this project"
          disabled={saving}
          onPress={() => void decide(true)}
        />
        <Button
          label="Keep monitoring"
          variant="secondary"
          disabled={saving}
          onPress={() => void decide(false)}
        />
      </Group>
    </Card>
  );
}
