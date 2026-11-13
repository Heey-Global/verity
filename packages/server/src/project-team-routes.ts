import type { FastifyInstance } from 'fastify';
import {
  ProjectTeamError,
  type EventStore,
  type ProjectInvitation,
  type ProjectMember,
} from '@verity/store';
import { z } from 'zod';
import './fastify-augmentation.js';
import { viewerId } from './view-state-routes.js';

type Store = Pick<EventStore, 'projectTeam' | 'userProfiles'>;

const projectParams = z.object({ id: z.string().min(1).max(200) }).strict();
const invitationParams = projectParams.extend({ invitationId: z.string().uuid() }).strict();
const memberParams = projectParams.extend({ userId: z.string().min(1).max(200) }).strict();
const inviteBody = z
  .object({
    inviteeName: z.string().trim().min(1).max(80),
    /** "Can edit"; without it the person can read. */
    canExecute: z.boolean(),
    /** The inviter's own name, as invited people see it (asked once). */
    inviterName: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
const rightsBody = z.object({ canExecute: z.boolean(), canManage: z.boolean() }).strict();

const publicInvitation = (invitation: ProjectInvitation) => ({
  id: invitation.id,
  inviteeName: invitation.inviteeName,
  canExecute: invitation.canExecute,
  state: invitation.state,
  expiresAt: invitation.expiresAt.toISOString(),
  createdAt: invitation.createdAt.toISOString(),
});

const publicMember = (member: ProjectMember) => ({
  userId: member.userId,
  displayName: member.displayName,
  canRead: member.canRead,
  canExecute: member.canExecute,
  canManage: member.canManage,
  creator: member.creator,
  joinedAt: member.joinedAt.toISOString(),
});

/**
 * A project's team: its members and open invitations (ADR 0023 §1). Every route
 * needs the permission to manage the project, which the route policy enforces.
 */
export function registerProjectTeamRoutes(
  app: FastifyInstance,
  deps: {
    store: Store;
    /**
     * The `https://verity.build/join#…` link of an invitation Uplink created
     * (D5), or undefined while it cannot be built yet.
     */
    invitationLink?: (
      invitation: ProjectInvitation,
      secret: string,
      display: { inviterName: string; projectName: string },
    ) => Promise<string | undefined>;
    projectName: (projectId: string) => Promise<string | undefined>;
    /** Ends the person's access to the project at once (ADR 0023 §6). */
    onMemberRemoved?: (projectId: string, userId: string) => Promise<void>;
  },
): void {
  const team = () => deps.store.projectTeam;
  const refusal = (error: unknown) => {
    if (!(error instanceof ProjectTeamError)) throw error;
    const status = error.code === 'member_not_found' ? 404 : 409;
    return { status, body: { error: error.message, code: error.code } };
  };
  const link = async (invitation: ProjectInvitation, projectId: string, viewer: string) => {
    if (deps.invitationLink === undefined || invitation.state !== 'open') return null;
    const secret = await team().invitationSecret(projectId, invitation.id);
    if (secret === undefined) return null;
    const inviterName = (await deps.store.userProfiles.read(viewer))?.displayName ?? 'Verity';
    const projectName = (await deps.projectName(projectId)) ?? 'Project';
    return (await deps.invitationLink(invitation, secret, { inviterName, projectName })) ?? null;
  };

  app.get('/projects/:id/team', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    reply.header('cache-control', 'no-store');
    const [members, invitations] = await Promise.all([
      team().listMembers(id),
      team().listInvitations(id),
    ]);
    return {
      members: members.map(publicMember),
      invitations: invitations.map(publicInvitation),
    };
  });

  app.post('/projects/:id/invitations', async (request, reply) => {
    const { id } = projectParams.parse(request.params);
    const body = inviteBody.parse(request.body);
    const viewer = viewerId(request);
    if (body.inviterName !== undefined)
      await deps.store.userProfiles.setDisplayName(viewer, body.inviterName);
    try {
      const { invitation } = await team().createInvitation({
        projectId: id,
        inviterUserId: viewer,
        inviteeName: body.inviteeName,
        canExecute: body.canExecute,
      });
      reply.header('cache-control', 'no-store').code(201);
      return { invitation: publicInvitation(invitation), link: null };
    } catch (error) {
      const { status, body: answer } = refusal(error);
      return reply.code(status).send(answer);
    }
  });

  app.get('/projects/:id/invitations/:invitationId', async (request, reply) => {
    const { id, invitationId } = invitationParams.parse(request.params);
    const invitation = (await team().listInvitations(id)).find(
      (candidate) => candidate.id === invitationId,
    );
    if (invitation === undefined) return reply.code(404).send({ error: 'invitation not found' });
    reply.header('cache-control', 'no-store');
    return {
      invitation: publicInvitation(invitation),
      link: await link(invitation, id, viewerId(request)),
    };
  });

  app.delete('/projects/:id/invitations/:invitationId', async (request, reply) => {
    const { id, invitationId } = invitationParams.parse(request.params);
    if (!(await team().revokeInvitation(id, invitationId)))
      return reply.code(404).send({ error: 'invitation not found' });
    return reply.code(204).send();
  });

  app.patch('/projects/:id/members/:userId', async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params);
    const rights = rightsBody.parse(request.body);
    try {
      return { member: publicMember(await team().setMemberRights(id, userId, rights)) };
    } catch (error) {
      const { status, body } = refusal(error);
      return reply.code(status).send(body);
    }
  });

  app.delete('/projects/:id/members/:userId', async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params);
    try {
      await team().removeMember(id, userId);
    } catch (error) {
      const { status, body } = refusal(error);
      return reply.code(status).send(body);
    }
    await deps.onMemberRemoved?.(id, userId);
    return reply.code(204).send();
  });
}
