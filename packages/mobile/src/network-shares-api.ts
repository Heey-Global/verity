import { z } from 'zod';

import type { TransportRequestInit } from './api.js';

// Network shares (SMB) connected centrally and the folders projects may use.
// `VerityClient` carries these calls as `networkShares`
// (docs/adr/0029-module-boundaries-and-file-size.md).

export const networkShareConnectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** `smb://server/shared-folder`, as entered. */
  address: z.string(),
  username: z.string(),
  projectCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type NetworkShareConnection = z.infer<typeof networkShareConnectionSchema>;

const networkShareAccessModeSchema = z.enum(['read-only', 'read-write']);
export type NetworkShareAccessMode = z.infer<typeof networkShareAccessModeSchema>;

export const projectNetworkShareFolderSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  connectionLabel: z.string(),
  /** The folder inside the share, `/`-separated; '' is the shared folder itself. */
  path: z.string(),
  name: z.string(),
  accessMode: networkShareAccessModeSchema,
  /** The connection now points elsewhere; the folder must be granted again. */
  stale: z.boolean(),
});
export type ProjectNetworkShareFolder = z.infer<typeof projectNetworkShareFolderSchema>;

const networkShareFolderListingSchema = z.object({
  path: z.string(),
  folders: z.array(z.object({ name: z.string(), path: z.string() })),
});
export type NetworkShareFolderListing = z.infer<typeof networkShareFolderListingSchema>;

const networkShareTestResultSchema = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
  error: z.string().optional(),
});
export type NetworkShareTestResult = z.infer<typeof networkShareTestResultSchema>;

type Request = (path: string, init: TransportRequestInit) => Promise<Response>;
const json = (method: string, body: unknown): TransportRequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const connection = (id: string) => `/network-shares/${encodeURIComponent(id)}`;
const folders = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/network-shares/folders`;

/** The network share calls, bound to the client's `request`. */
export function networkSharesClient(request: Request) {
  return {
    /** Connected shares; administrators only. Passwords are never returned. */
    listConnections: async (): Promise<NetworkShareConnection[]> => {
      const res = await request('/network-shares', { method: 'GET' });
      return z
        .object({ connections: z.array(networkShareConnectionSchema) })
        .parse(await res.json()).connections;
    },
    /** Connects a share; the server saves it only after a successful encrypted sign-in. */
    addConnection: async (input: {
      label: string;
      address: string;
      username: string;
      password: string;
    }): Promise<NetworkShareConnection> => {
      const res = await request('/network-shares', json('POST', input));
      return networkShareConnectionSchema.parse(await res.json());
    },
    /** Renames a share or changes its address or sign-in; a new address ends project access. */
    updateConnection: async (
      id: string,
      patch: { label?: string; address?: string; username?: string; password?: string },
    ): Promise<NetworkShareConnection> => {
      const res = await request(connection(id), json('PATCH', patch));
      return networkShareConnectionSchema.parse(await res.json());
    },
    /** Disconnects a share; every project loses its folders on it. */
    removeConnection: async (id: string): Promise<void> => {
      await request(connection(id), { method: 'DELETE' });
    },
    /** Reuses a recent result unless `fresh`; every real test is a sign-in on the NAS. */
    testConnection: async (id: string, fresh = false): Promise<NetworkShareTestResult> => {
      const res = await request(`${connection(id)}/test${fresh ? '?fresh=1' : ''}`, {
        method: 'POST',
      });
      return networkShareTestResultSchema.parse(await res.json());
    },
    /** The folders directly inside `path` of a share, for choosing one. */
    browseFolders: async (id: string, path = ''): Promise<NetworkShareFolderListing> => {
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await request(`${connection(id)}/folders${query}`, { method: 'GET' });
      return networkShareFolderListingSchema.parse(await res.json());
    },
    listProjectFolders: async (projectId: string): Promise<ProjectNetworkShareFolder[]> => {
      const res = await request(folders(projectId), { method: 'GET' });
      return z.object({ folders: z.array(projectNetworkShareFolderSchema) }).parse(await res.json())
        .folders;
    },
    grantProjectFolder: async (
      projectId: string,
      input: { connectionId: string; path: string; accessMode: NetworkShareAccessMode },
    ): Promise<ProjectNetworkShareFolder> => {
      const res = await request(folders(projectId), json('POST', input));
      return projectNetworkShareFolderSchema.parse(await res.json());
    },
    setProjectFolderAccess: async (
      projectId: string,
      folderId: string,
      accessMode: NetworkShareAccessMode,
    ): Promise<ProjectNetworkShareFolder> => {
      const res = await request(
        `${folders(projectId)}/${encodeURIComponent(folderId)}`,
        json('PATCH', { accessMode }),
      );
      return projectNetworkShareFolderSchema.parse(await res.json());
    },
    removeProjectFolder: async (projectId: string, folderId: string): Promise<void> => {
      await request(`${folders(projectId)}/${encodeURIComponent(folderId)}`, {
        method: 'DELETE',
      });
    },
  };
}
