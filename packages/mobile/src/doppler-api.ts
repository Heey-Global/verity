import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// Several Doppler connections per instance and several Doppler bindings per
// project (docs/adr/0031-multiple-doppler-connections.md). `VerityClient` carries
// these calls as `doppler` (docs/adr/0029-module-boundaries-and-file-size.md).

export const dopplerConnectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hasToken: z.boolean(),
  workplaceSlug: z.string().nullable(),
  workplaceName: z.string().nullable(),
  createdAt: z.string(),
  projectCount: z.number().int().nonnegative(),
});
export type DopplerConnection = z.infer<typeof dopplerConnectionSchema>;

export const dopplerConnectionUsageSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string(),
      bindings: z.array(
        z.object({
          id: z.string(),
          dopplerProject: z.string(),
          dopplerConfig: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  ),
});
export type DopplerConnectionUsage = z.infer<typeof dopplerConnectionUsageSchema>;

export const projectDopplerBindingSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionLabel: z.string(),
  dopplerProject: z.string(),
  dopplerConfig: z.string(),
  isDefault: z.boolean(),
  /** How agents address the binding's secrets: `project/config` before the name. */
  reference: z.string(),
  createdAt: z.string(),
});
export type ProjectDopplerBinding = z.infer<typeof projectDopplerBindingSchema>;

/** The signed-in person's own Doppler tokens for a project, one per connection. */
export const personalDopplerTokensSchema = z.object({
  canManageBindings: z.boolean().optional(),
  connections: z
    .array(
      z.object({
        connectionId: z.string(),
        label: z.string(),
        bindings: z.array(z.string()),
        connected: z.boolean(),
        needsValidation: z.boolean().optional(),
        updatedAt: z.string().nullable(),
        usesInstanceToken: z.boolean(),
      }),
    )
    .default([]),
});
export type PersonalDopplerTokens = z.infer<typeof personalDopplerTokensSchema>;

// The instance-level picker results, from before several connections existed.

/** Result of `POST /doppler/validate` (#320, onboarding — OPTIONAL step): a live
 *  check that the stored Doppler Service Account token actually lists projects.
 *  `ok` confirms the token works. `projectCount` is a SAFE confirmation integer on
 *  success; `error` is a redacted failure message (`'locked'` when the store is
 *  sealed, `'not configured'` when the token is missing). The server NEVER returns
 *  the token here. */
export const dopplerValidateSchema = z.object({
  ok: z.boolean(),
  projectCount: z.number().optional(),
  error: z.string().optional(),
});
export type DopplerValidateResult = z.infer<typeof dopplerValidateSchema>;

/** A single Doppler project in the binding picker (#320, `GET /doppler/projects`).
 *  `slug` is the stable identifier the mapping PATCH uses as `dopplerProject`; `name`
 *  is the display label. NON-secret. */
export const dopplerProjectSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
});
export type DopplerProjectSummary = z.infer<typeof dopplerProjectSummarySchema>;

/** A single Doppler config in the binding picker (#320, `GET /doppler/configs`).
 *  `name` is what the mapping PATCH uses as `dopplerConfig`; `environment` / `root`
 *  let the UI group root vs branch configs (deferred). NON-secret. */
export const dopplerConfigSummarySchema = z.object({
  name: z.string(),
  environment: z.string().optional(),
  root: z.boolean().optional(),
});
export type DopplerConfigSummary = z.infer<typeof dopplerConfigSummarySchema>;

/** Result of `GET /doppler/projects` (#320, binding picker): the account's Doppler
 *  projects from the TRUSTED account token (server-side; NOT repo content), or a
 *  redacted `{ error }` envelope. `error: 'locked'` = the store is sealed;
 *  `'not configured'` = no account token. The token is NEVER on the wire. */
export const dopplerProjectsResultSchema = z.union([
  z.object({ projects: z.array(dopplerProjectSummarySchema) }),
  z.object({ error: z.string() }),
]);
export type DopplerProjectsResult = z.infer<typeof dopplerProjectsResultSchema>;

/** Result of `GET /doppler/configs?project=<project>` (#320, binding picker): the
 *  project's configs from the TRUSTED account token, or a redacted `{ error }`
 *  envelope (`'locked'` / `'not configured'` / `'project is required'`). */
export const dopplerConfigsResultSchema = z.union([
  z.object({ configs: z.array(dopplerConfigSummarySchema) }),
  z.object({ error: z.string() }),
]);
export type DopplerConfigsResult = z.infer<typeof dopplerConfigsResultSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;
const json = (method: string, body: unknown): TransportRequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const connection = (id: string) => `/doppler/connections/${encodeURIComponent(id)}`;
const bindings = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/doppler/bindings`;
const personal = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/doppler/connection`;

/** The Doppler calls, bound to the client's `request`. */
export function dopplerClient(request: Request) {
  return {
    /** The instance's connections; administrators only. Tokens are never returned. */
    listConnections: async (): Promise<DopplerConnection[]> => {
      const res = await request('/doppler/connections', { method: 'GET' });
      return z.object({ connections: z.array(dopplerConnectionSchema) }).parse(await res.json())
        .connections;
    },
    /** Adds a connection once Doppler accepted the token. */
    addConnection: async (input: { label: string; token: string }): Promise<DopplerConnection> => {
      const res = await request('/doppler/connections', json('POST', input));
      return dopplerConnectionSchema.parse(await res.json());
    },
    /** Renames a connection or replaces its token. */
    updateConnection: async (
      id: string,
      patch: { label?: string; token?: string; confirmTokenReplacement?: boolean },
    ): Promise<DopplerConnection> => {
      const res = await request(connection(id), json('PATCH', patch));
      return dopplerConnectionSchema.parse(await res.json());
    },
    /** The projects and bindings that use a connection, for the delete warning. */
    connectionUsage: async (id: string): Promise<DopplerConnectionUsage> => {
      const res = await request(`${connection(id)}/usage`, { method: 'GET' });
      return dopplerConnectionUsageSchema.parse(await res.json());
    },
    /** Deletes a connection only if its bindings match those shown at confirmation. */
    removeConnection: async (id: string, bindingIds: readonly string[]): Promise<void> => {
      await request(connection(id), json('DELETE', { bindingIds }));
    },
    listBindings: async (projectId: string): Promise<ProjectDopplerBinding[]> => {
      const res = await request(bindings(projectId), { method: 'GET' });
      return z.object({ bindings: z.array(projectDopplerBindingSchema) }).parse(await res.json())
        .bindings;
    },
    addBinding: async (
      projectId: string,
      input: { connectionId: string; dopplerProject: string; dopplerConfig: string },
    ): Promise<ProjectDopplerBinding> => {
      const res = await request(bindings(projectId), json('POST', input));
      return projectDopplerBindingSchema.parse(await res.json());
    },
    setDefaultBinding: async (
      projectId: string,
      bindingId: string,
    ): Promise<ProjectDopplerBinding[]> => {
      const res = await request(
        `${bindings(projectId)}/${encodeURIComponent(bindingId)}`,
        json('PATCH', { isDefault: true }),
      );
      return z.object({ bindings: z.array(projectDopplerBindingSchema) }).parse(await res.json())
        .bindings;
    },
    removeBinding: async (
      projectId: string,
      bindingId: string,
      isDefault?: boolean,
    ): Promise<void> => {
      await request(
        `${bindings(projectId)}/${encodeURIComponent(bindingId)}`,
        isDefault === undefined ? { method: 'DELETE' } : json('DELETE', { isDefault }),
      );
    },
    /** The signed-in person's own tokens for the project's connections. */
    personalTokens: async (projectId: string): Promise<PersonalDopplerTokens> => {
      const res = await request(personal(projectId), { method: 'GET' });
      return personalDopplerTokensSchema.parse(await res.json());
    },
    /** Stores the person's own token for one connection, once it reads its configs. */
    connectPersonalToken: async (
      projectId: string,
      connectionId: string,
      token: string,
    ): Promise<PersonalDopplerTokens> => {
      const res = await request(personal(projectId), json('PUT', { token, connectionId }));
      return personalDopplerTokensSchema.parse(await res.json());
    },
    disconnectPersonalToken: async (projectId: string, connectionId: string): Promise<void> => {
      await request(`${personal(projectId)}?connectionId=${encodeURIComponent(connectionId)}`, {
        method: 'DELETE',
      });
    },
  };
}
