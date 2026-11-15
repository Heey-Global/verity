import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// The calls of shared projects (ADR 0023): a project's team and invitations,
// joining a team, and the signed-in person's own provider accounts. `VerityClient`
// carries them as its own methods (docs/adr/0029-module-boundaries-and-file-size.md).

export const agentLoginProviderSchema = z.enum(['claude', 'codex']);
export type AgentLoginProvider = z.infer<typeof agentLoginProviderSchema>;
export const agentLoginSchema = z.object({
  sessionId: z.string().min(1),
  provider: agentLoginProviderSchema,
  status: z.enum(['starting', 'ready', 'waiting', 'complete', 'failed']),
  verificationUri: z.string().nullable(),
  userCode: z.string().nullable(),
  needsCode: z.boolean(),
  configured: z.boolean(),
  message: z.string().nullable(),
});
export type AgentLogin = z.infer<typeof agentLoginSchema>;
export const agentLoginResponseSchema = z.object({ login: agentLoginSchema });

/** A project's team (ADR 0023 §1): members and open invitations. */
const projectMemberSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullable(),
  canRead: z.boolean(),
  canExecute: z.boolean(),
  canManage: z.boolean(),
  creator: z.boolean(),
  joinedAt: z.string(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;
const projectInvitationSchema = z.object({
  id: z.string(),
  inviteeName: z.string(),
  canExecute: z.boolean(),
  /** `failed`: the join or the invitation did not go through; invite again. */
  state: z.enum(['creating', 'open', 'redeemed', 'revoked', 'expired', 'failed']),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export type ProjectInvitation = z.infer<typeof projectInvitationSchema>;
export const projectTeamSchema = z.object({
  members: z.array(projectMemberSchema),
  invitations: z.array(projectInvitationSchema),
});
export type ProjectTeam = z.infer<typeof projectTeamSchema>;
/** What the server holds of a join link; the inviter's app adds pin and address. */
export const invitationLinkFieldsSchema = z.object({
  version: z.literal(1),
  purpose: z.literal('team-member'),
  invitationId: z.string(),
  secret: z.string(),
  expiresAt: z.number(),
  serverId: z.string(),
  identityKey: z.string(),
  uplinkOrigin: z.string(),
  installationId: z.string(),
  installationHandle: z.string(),
  display: z.object({ inviterName: z.string(), projectName: z.string() }).optional(),
});
export type InvitationLinkFields = z.infer<typeof invitationLinkFieldsSchema>;
const invitationResponseSchema = z.object({
  invitation: projectInvitationSchema,
  linkFields: invitationLinkFieldsSchema.nullable(),
});

/** A provider account of the signed-in person's own (ADR 0023 §3). */
const providerConnectionKindSchema = z.enum(['claude', 'codex', 'opencode']);
export type ProviderConnectionKind = z.infer<typeof providerConnectionKindSchema>;
const providerConnectionSchema = z.object({
  provider: providerConnectionKindSchema,
  baseUrl: z.string().nullable(),
  models: z.array(z.string()),
  updatedAt: z.string(),
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export const providerConnectionsSchema = z.object({
  connections: z.array(providerConnectionSchema),
  /** The administrator's turns fall back to the instance logins. */
  usesInstanceLogins: z.boolean(),
});
export type ProviderConnections = z.infer<typeof providerConnectionsSchema>;
const openCodeConnectionSchema = z.object({
  provider: z.literal('opencode'),
  baseUrl: z.string(),
  models: z.array(z.string()),
});

const teamJoinedSchema = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  userId: z.string().min(1),
  projectId: z.string().min(1),
});
export type TeamJoined = z.infer<typeof teamJoinedSchema>;

interface RequestHost {
  request(path: string, init: TransportRequestInit): Promise<Response>;
}
/** The client these methods are called on; its `request` is private to it. */
const host = (client: unknown): RequestHost => client as RequestHost;

export const peopleClientMethods = {
  async getProjectTeam(this: unknown, projectId: string): Promise<ProjectTeam> {
    const res = await host(this).request(`/projects/${encodeURIComponent(projectId)}/team`, {
      method: 'GET',
    });
    return projectTeamSchema.parse(await res.json());
  },

  /** Invite a person to read, or to read and send messages ("Can edit"). */
  async createProjectInvitation(
    this: unknown,
    projectId: string,
    input: { inviteeName: string; canExecute: boolean; inviterName?: string },
  ): Promise<{ invitation: ProjectInvitation; linkFields: InvitationLinkFields | null }> {
    const res = await host(this).request(`/projects/${encodeURIComponent(projectId)}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return invitationResponseSchema.parse(await res.json());
  },

  async getProjectInvitation(
    this: unknown,
    projectId: string,
    invitationId: string,
  ): Promise<{ invitation: ProjectInvitation; linkFields: InvitationLinkFields | null }> {
    const res = await host(this).request(
      `/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'GET' },
    );
    return invitationResponseSchema.parse(await res.json());
  },

  async revokeProjectInvitation(
    this: unknown,
    projectId: string,
    invitationId: string,
  ): Promise<void> {
    await host(this).request(
      `/projects/${encodeURIComponent(projectId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' },
    );
  },

  async setProjectMemberRights(
    this: unknown,
    projectId: string,
    userId: string,
    rights: { canExecute: boolean; canManage: boolean },
  ): Promise<ProjectMember> {
    const res = await host(this).request(
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rights),
      },
    );
    return z.object({ member: projectMemberSchema }).parse(await res.json()).member;
  },

  async removeProjectMember(this: unknown, projectId: string, userId: string): Promise<void> {
    await host(this).request(
      `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  },

  /** The signed-in person's own provider accounts; never any credential. */
  async listProviderConnections(this: unknown): Promise<ProviderConnections> {
    const res = await host(this).request('/me/provider-connections', { method: 'GET' });
    return providerConnectionsSchema.parse(await res.json());
  },

  /** Starts a login whose result becomes the signed-in person's own account. */
  async startProviderConnectionLogin(
    this: unknown,
    provider: AgentLoginProvider,
  ): Promise<AgentLogin> {
    const res = await host(this).request(`/me/provider-connections/${provider}/login`, {
      method: 'POST',
    });
    return agentLoginResponseSchema.parse(await res.json()).login;
  },

  async getProviderConnectionLogin(this: unknown, sessionId: string): Promise<AgentLogin> {
    const res = await host(this).request(
      `/me/provider-connections/logins/${encodeURIComponent(sessionId)}`,
      { method: 'GET' },
    );
    return agentLoginResponseSchema.parse(await res.json()).login;
  },

  async submitProviderConnectionLoginCode(
    this: unknown,
    sessionId: string,
    code: string,
  ): Promise<AgentLogin> {
    const res = await host(this).request(
      `/me/provider-connections/logins/${encodeURIComponent(sessionId)}/code`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      },
    );
    return agentLoginResponseSchema.parse(await res.json()).login;
  },

  /** Saves the person's own OpenCode provider after it answered with its models. */
  async setOpenCodeConnection(
    this: unknown,
    input: {
      baseUrl: string;
      apiKey: string;
    },
  ): Promise<z.infer<typeof openCodeConnectionSchema>> {
    const res = await host(this).request('/me/provider-connections/opencode', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return openCodeConnectionSchema.parse(await res.json());
  },

  async disconnectProviderConnection(
    this: unknown,
    provider: ProviderConnectionKind,
  ): Promise<void> {
    await host(this).request(`/me/provider-connections/${provider}`, { method: 'DELETE' });
  },

  /** Sets the signed-in person's own default model for a project. */
  async setOwnProjectDefaultModel(
    this: unknown,
    projectId: string,
    model: string | null,
  ): Promise<{ defaultModel: string | null }> {
    const res = await host(this).request(
      `/projects/${encodeURIComponent(projectId)}/default-model`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      },
    );
    return z.object({ defaultModel: z.string().nullable() }).parse(await res.json());
  },

  /**
   * Join a project with a team invitation, pairing this device to the invited
   * person (ADR 0023 §7). Unauthenticated: the invitation secret is the
   * credential. A retry with the same `redemptionId` is a replay.
   */
  async joinTeam(
    this: unknown,
    body: {
      invitationId: string;
      secret: string;
      redemptionId: string;
      displayName: string;
      deviceLabel?: string;
    },
  ): Promise<TeamJoined> {
    const res = await host(this).request('/team/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return teamJoinedSchema.parse(await res.json());
  },
};
