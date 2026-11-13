// Project › Settings › Team: who works in the project, open invitations, and
// each member's right (ADR 0023 §1). Only managers reach it.
import type { ProjectMember, ProjectTeam, VerityClient } from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { SettingsMessage, SettingsScaffold } from '../../../../components/settings/SettingsChrome';
import {
  Button,
  Group,
  Row,
  SectionHeader,
  Sheet,
  StatusTag,
  Text,
  useConfirm,
} from '../../../../components/ui';
import { createVerityClient } from '../../../../lib/client';
import { projectIdParam } from '../../../../lib/useProjectDetail';

export default function ProjectTeamScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const projectId = projectIdParam(id);
  const client = useMemo(() => createVerityClient(), []);
  if (!client || projectId.length === 0) {
    return (
      <SettingsMessage
        title="Project unavailable"
        subtitle="This project could not be opened. Go back and pick it again."
        screenTitle="Team"
      />
    );
  }
  return <ProjectTeamView client={client} projectId={projectId} />;
}

/** The right a member holds, as the team page names it. */
export function rightLabel(member: Pick<ProjectMember, 'canExecute' | 'canManage'>): string {
  if (member.canManage) return 'Manage';
  return member.canExecute ? 'Can edit' : 'Can read';
}

function Initials({ name }: { name: string }) {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0]!.toUpperCase())
    .join('');
  return (
    <Text variant="label" tone="action">
      {initials || '?'}
    </Text>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function ProjectTeamView({
  client,
  projectId,
}: {
  client: VerityClient;
  projectId: string;
}) {
  const [team, setTeam] = useState<ProjectTeam | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<ProjectMember | null>(null);
  const [confirm, confirmSheet] = useConfirm();

  const load = useCallback(() => {
    setError(undefined);
    client
      .getProjectTeam(projectId)
      .then(setTeam)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load the team'),
      );
  }, [client, projectId]);
  useFocusEffect(load);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change the team');
    } finally {
      setBusy(false);
    }
  };
  const setRights = (member: ProjectMember, canExecute: boolean, canManage: boolean) =>
    act(async () => {
      setOpen(
        await client.setProjectMemberRights(projectId, member.userId, { canExecute, canManage }),
      );
    });
  const remove = (member: ProjectMember) =>
    confirm({
      title: `Remove ${member.displayName ?? 'this person'}?`,
      message: 'Their access to this project ends at once.',
      confirmLabel: 'Remove',
      destructive: true,
      afterSheet: true,
      onConfirm: () => act(() => client.removeProjectMember(projectId, member.userId)),
    });

  const name = (member: ProjectMember) => member.displayName ?? 'Member';
  return (
    <SettingsScaffold title="Team" detail state={{ error, saving: busy }} onRetry={load}>
      {team === null ? null : (
        <>
          <SectionHeader title={`Members · ${String(team.members.length)}`} variant="eyebrow" />
          <Group>
            {team.members.map((member) => (
              <Row
                key={member.userId}
                leading={{ element: <Initials name={name(member)} /> }}
                title={name(member)}
                subtitle={
                  member.creator ? 'Owner of this project' : `Joined ${shortDate(member.joinedAt)}`
                }
                trailing={
                  <StatusTag
                    intent={member.canManage ? 'action' : member.canExecute ? 'ready' : 'optional'}
                    label={rightLabel(member)}
                  />
                }
                {...(member.creator ? {} : { navigates: true, onPress: () => setOpen(member) })}
              />
            ))}
          </Group>
          {team.invitations.length > 0 ? (
            <>
              <SectionHeader
                title={`Open invitations · ${String(team.invitations.length)}`}
                variant="eyebrow"
              />
              <Group>
                {team.invitations.map((invitation) => (
                  <Row
                    key={invitation.id}
                    leading={{ icon: 'link', quiet: true }}
                    title={`Invitation for ${invitation.inviteeName}`}
                    subtitle={`${invitation.canExecute ? 'Can edit' : 'Can read'} · ${
                      invitation.state === 'expired'
                        ? 'expired'
                        : `valid until ${shortDate(invitation.expiresAt)}`
                    }`}
                    trailing={
                      <StatusTag
                        intent={invitation.state === 'expired' ? 'needsSetup' : 'optional'}
                        label={invitation.state === 'expired' ? 'Expired' : 'Open'}
                      />
                    }
                    navigates
                    onPress={() =>
                      router.push({
                        pathname: '/project/[id]/settings/invitation',
                        params: { id: projectId, invitationId: invitation.id },
                      })
                    }
                  />
                ))}
              </Group>
            </>
          ) : null}
          <Button
            label="Invite a person"
            icon="user-plus"
            onPress={() =>
              router.push({ pathname: '/project/[id]/settings/invite', params: { id: projectId } })
            }
            fullWidth
          />
        </>
      )}
      <Sheet
        visible={open !== null}
        title={open === null ? '' : name(open)}
        titleLeading={open === null ? undefined : <Initials name={name(open)} />}
        onClose={() => setOpen(null)}
        footer={
          open === null ? undefined : (
            <Button
              label="Remove from project"
              variant="destructive"
              onPress={() => {
                const member = open;
                setOpen(null);
                remove(member);
              }}
              fullWidth
            />
          )
        }
      >
        {open === null ? null : (
          <Group>
            <Row
              selected={!open.canExecute && !open.canManage}
              title="Can read"
              onPress={() => void setRights(open, false, false)}
            />
            <Row
              selected={open.canExecute && !open.canManage}
              title="Can edit"
              onPress={() => void setRights(open, true, false)}
            />
            <Row
              selected={open.canManage}
              title="Can manage"
              subtitle="Also invites people and changes their rights"
              onPress={() => void setRights(open, true, true)}
            />
          </Group>
        )}
      </Sheet>
      {confirmSheet}
    </SettingsScaffold>
  );
}
