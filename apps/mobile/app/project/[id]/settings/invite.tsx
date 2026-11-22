// Inviting a person to one project: the inviter's own name (asked once), who
// is invited and their rights: reading always, sending messages and working
// with code as chosen. Invitations never grant managing.
import type { TeamRights, VerityClient } from '@verity/mobile';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';

import { SettingsMessage, SettingsScaffold } from '../../../../components/settings/SettingsChrome';
import { TeamRightsGroup } from '../../../../components/settings/TeamRightsGroup';
import { Button, Group, Row, SectionHeader, TextField } from '../../../../components/ui';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam, useProjectDetail } from '../../../../lib/useProjectDetail';

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Invite"
      />
    );
  }
  return <InviteView client={client} projectId={projectId} />;
}

export function InviteView({ client, projectId }: { client: VerityClient; projectId: string }) {
  const { detail } = useProjectDetail(client, projectId);
  const [inviterName, setInviterName] = useState('');
  const [inviteeName, setInviteeName] = useState('');
  // Edit is offered by default; Code is a deliberate choice.
  const [rights, setRights] = useState<TeamRights>({
    canExecute: true,
    canCode: false,
    canManage: false,
  });
  const { canExecute, canCode } = rights;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const projectName = detail?.project.name ?? 'this project';
  const ready = inviteeName.trim() !== '';

  const create = () => {
    if (!ready) return;
    setSaving(true);
    setError(undefined);
    client
      .createProjectInvitation(projectId, {
        inviteeName: inviteeName.trim(),
        canExecute,
        // Only when chosen: a server that predates Code refuses the field.
        ...(canCode ? { canCode } : {}),
        ...(inviterName.trim() === '' ? {} : { inviterName: inviterName.trim() }),
      })
      .then(({ invitation }) =>
        router.replace({
          pathname: '/project/[id]/settings/invitation',
          params: { id: projectId, invitationId: invitation.id },
        }),
      )
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not create the invitation'),
      )
      .finally(() => setSaving(false));
  };

  return (
    <SettingsScaffold
      title="Invite"
      detail
      state={{ error, saving }}
      footer={
        <Button
          label="Create invitation"
          onPress={create}
          disabled={!ready}
          loading={saving}
          fullWidth
        />
      }
    >
      <TextField
        label="Your name, as invited people see it"
        value={inviterName}
        onChangeText={setInviterName}
      />
      <TextField label="Who are you inviting?" value={inviteeName} onChangeText={setInviteeName} />
      <SectionHeader title={`Rights in “${projectName}”`} variant="eyebrow" />
      <TeamRightsGroup rights={rights} onChange={setRights} />
      <SectionHeader
        title={`${inviteeName.trim() === '' ? 'They' : inviteeName.trim()} see`}
        variant="eyebrow"
      />
      <Group>
        <Row leading={{ icon: 'eye', quiet: true }} title={`The project “${projectName}”`} />
        <Row
          leading={{ icon: 'cpu' }}
          title="Brings their own AI connection"
          subtitle={canExecute ? 'Required to send messages' : undefined}
        />
      </Group>
    </SettingsScaffold>
  );
}
