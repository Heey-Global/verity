// Project › Settings › Team: who works in the project, open invitations, and
// each member's rights (ADR 0023 §1). Only managers reach it.
import {
  teamRightLabel,
  teamSharingUnavailable,
  type ProjectMember,
  type ProjectTeam,
  type TeamRights,
  type VerityClient,
} from '@verity/mobile';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { SettingsMessage, SettingsScaffold } from '../../../../components/settings/SettingsChrome';
import { TeamRightsGroup } from '../../../../components/settings/TeamRightsGroup';
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
  // A server that predates Code reports no `canCode` and refuses the field.
  const setRights = (member: ProjectMember, rights: TeamRights) =>
    act(async () => {
      setOpen(
        await client.setProjectMemberRights(projectId, member.userId, {
          canExecute: rights.canExecute,
          ...(member.canCode === undefined ? {} : { canCode: rights.canCode }),
          canManage: rights.canManage,
        }),
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
  // Without team sharing an invitation never gets its link: offer none, and
  // say so plainly (only managers see this page).
  const canInvite = !teamSharingUnavailable(team?.teamSharing);
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
                    label={teamRightLabel(member)}
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
                      invitation.state === 'failed'
                        ? 'did not go through'
                        : invitation.state === 'expired'
                          ? 'expired'
                          : `valid until ${shortDate(invitation.expiresAt)}`
                    }`}
                    trailing={
                      <StatusTag
                        intent={invitation.state === 'open' ? 'optional' : 'needsSetup'}
                        label={
                          invitation.state === 'failed'
                            ? 'Invite again'
                            : invitation.state === 'expired'
                              ? 'Expired'
                              : 'Open'
                        }
                      />
                    }
                    navigates
                    onPress={() =>
                      invitation.state === 'failed' && canInvite
                        ? router.push({
                            pathname: '/project/[id]/settings/invite',
                            params: { id: projectId },
                          })
                        : router.push({
                            pathname: '/project/[id]/settings/invitation',
                            params: { id: projectId, invitationId: invitation.id },
                          })
                    }
                  />
                ))}
              </Group>
            </>
          ) : null}
          {canInvite ? (
            <Button
              label="Invite a person"
              icon="user-plus"
              onPress={() =>
                router.push({
                  pathname: '/project/[id]/settings/invite',
                  params: { id: projectId },
                })
              }
              fullWidth
            />
          ) : (
            <Group>
              <Row
                leading={{ icon: 'info', quiet: true }}
                title="Team sharing isn't available for this installation"
                subtitle="People can't be invited to this project at the moment"
              />
            </Group>
          )}
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
          <TeamRightsGroup
            rights={{
              canExecute: open.canExecute,
              canCode: open.canCode ?? false,
              canManage: open.canManage,
            }}
            code={open.canCode !== undefined}
            manage
            disabled={busy}
            onChange={(rights) => void setRights(open, rights)}
          />
        )}
      </Sheet>
      {confirmSheet}
    </SettingsScaffold>
  );
}
