// The agent tool for network share folders granted to a project. Every call is
// checked against the project's current grant, so a revoked or downgraded
// folder stops working for running sessions with their next call.
import {
  InvalidNetworkSharePathError,
  networkSharePathWithin,
  normalizeNetworkSharePath,
  type EventStore,
  type ProjectNetworkShareFolderRecord,
} from '@verity/store';
import {
  networkShareIsMutation,
  networkShareRequestSchema,
  type NetworkShareRequest,
} from './network-share-request.js';

import { createHash } from 'node:crypto';

import { withNetworkShareTarget } from './network-share-routes.js';
import { NetworkShareError, type NetworkShareClient, type SmbTarget } from './network-share-smb.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

/**
 * What an approval for a replace covers: the folder's grant as the user saw it,
 * the file, the version it replaces and the exact new bytes. Any other request
 * under the same card no longer matches.
 */
function approvalBinding(
  request: Extract<NetworkShareRequest, { action: 'update' }>,
  folder: ProjectNetworkShareFolderRecord,
  sharePath: string,
): string {
  return JSON.stringify({
    folderId: folder.id,
    revision: folder.revision,
    path: sharePath,
    expectedVersion: request.expectedVersion,
    content: createHash('sha256')
      .update(`${request.encoding ?? 'utf8'}:${request.content}`)
      .digest('hex'),
  });
}

type Input = { projectId: string; sessionId: string; turnId: string; request: unknown };

interface Resolved {
  request: NetworkShareRequest;
  folder?: ProjectNetworkShareFolderRecord;
  /** The path on the share: the granted folder joined with the request's path. */
  sharePath?: string;
}

function decode(request: { content: string; encoding?: 'utf8' | 'base64' | undefined }): Buffer {
  if (request.encoding !== 'base64') return Buffer.from(request.content, 'utf8');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.content) || request.content.length % 4 !== 0)
    throw new ControlPlaneSessionToolError('content is not valid base64');
  return Buffer.from(request.content, 'base64');
}

function text(content: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
}

export function createNetworkShareTool(deps: {
  store: Pick<EventStore, 'getSession' | 'getProject' | 'networkShares'>;
  client: NetworkShareClient;
  isSealed?: () => boolean;
  /** Logs one write without its content or credentials. */
  logWrite?: (entry: {
    projectId: string;
    sessionId: string;
    folderId: string;
    path: string;
    action: 'create' | 'update';
    bytes: number;
  }) => void;
}) {
  const resolve = async (input: Input): Promise<Resolved> => {
    const parsed = networkShareRequestSchema.safeParse(input.request);
    if (!parsed.success) throw new ControlPlaneSessionToolError('invalid network share request');
    const request = parsed.data;
    const session = await deps.store.getSession(input.sessionId);
    if (session?.projectId !== input.projectId)
      throw new ControlPlaneSessionAuthorityError('session project changed');
    if (request.action === 'folders') return { request };
    const folder = await deps.store.networkShares.projectFolder(input.projectId, request.folderId);
    if (!folder || folder.stale)
      throw new ControlPlaneSessionAuthorityError(
        'This folder is not shared with the project (anymore). Call folders for the current list.',
      );
    let relative: string;
    try {
      relative = normalizeNetworkSharePath(request.path ?? '');
    } catch (error) {
      if (error instanceof InvalidNetworkSharePathError)
        throw new ControlPlaneSessionToolError(error.message);
      throw error;
    }
    const sharePath = [folder.path, relative].filter(Boolean).join('/');
    // Normalization already refuses `..`; this keeps the boundary explicit.
    if (!networkSharePathWithin(folder.path, sharePath))
      throw new ControlPlaneSessionAuthorityError('The path leaves the shared folder.');
    if ((request.action === 'read' || networkShareIsMutation(request)) && relative === '')
      throw new ControlPlaneSessionToolError('Name a file inside the folder.');
    if (networkShareIsMutation(request) && folder.accessMode !== 'read-write')
      throw new ControlPlaneSessionAuthorityError(
        'This project may only read this folder. An administrator can allow changes in project settings.',
      );
    return { request, folder, sharePath };
  };

  const run = async <T>(
    folder: ProjectNetworkShareFolderRecord,
    work: (target: SmbTarget) => Promise<T>,
  ): Promise<T> => {
    try {
      const result = await withNetworkShareTarget(deps, folder.connectionId, async (target) => {
        // The grant was made for one server and share; never follow a changed target.
        const current = await deps.store.networkShares.projectFolder(folder.projectId, folder.id);
        // The grant must still be the one this call was authorized against; a
        // downgrade between authorization and this point must stop a write.
        if (!current || current.stale || current.revision !== folder.revision) return undefined;
        return { value: await work(target) };
      });
      if (result === undefined)
        throw new ControlPlaneSessionAuthorityError(
          'This folder is no longer shared with the project.',
        );
      return result.value;
    } catch (error) {
      if (error instanceof NetworkShareError) throw new ControlPlaneSessionToolError(error.message);
      throw error;
    }
  };

  return {
    /** Refuses before any approval card: wrong project, no grant, path outside it, read-only. */
    async authorize(input: Input): Promise<void> {
      await resolve(input);
    },

    /** Reads and creating new files run under the grant; replacing a file asks the user. */
    async standing(input: Input): Promise<boolean> {
      const { request } = await resolve(input);
      return request.action !== 'update';
    },

    /** What an approval card binds to: the folder's grant as the user saw it. */
    async snapshot(input: Input): Promise<string | undefined> {
      const { request, folder, sharePath } = await resolve(input);
      if (request.action !== 'update' || !folder) return undefined;
      return approvalBinding(request, folder, sharePath);
    },

    async invoke(
      input: Input & { approvedByCard?: boolean; authorizationSnapshot?: string },
    ): Promise<unknown> {
      const { request, folder, sharePath } = await resolve(input);
      if (request.action === 'folders') {
        const folders = await deps.store.networkShares.projectFolders(input.projectId);
        return {
          folders: folders
            .filter((entry) => !entry.stale)
            .map((entry) => ({
              folderId: entry.id,
              name: entry.name,
              location: [entry.connectionLabel, ...entry.path.split('/').filter(Boolean)].join(
                ' › ',
              ),
              access: entry.accessMode,
            })),
        };
      }
      if (!folder || sharePath === undefined)
        throw new ControlPlaneSessionToolError('folder required');
      if (request.action === 'update') {
        // The approval covered this grant; a changed grant needs a new approval.
        const expected = approvalBinding(request, folder, sharePath);
        if (input.approvedByCard !== true || input.authorizationSnapshot !== expected)
          throw new ControlPlaneSessionAuthorityError(
            'Folder access changed since the approval. Ask again.',
          );
      }
      const relative = (path: string) => path.slice(folder.path.length).replace(/^\//, '');
      switch (request.action) {
        case 'list': {
          const entries = await run(folder, (target) => deps.client.list(target, sharePath));
          return { path: relative(sharePath), entries };
        }
        case 'read': {
          const file = await run(folder, (target) => deps.client.read(target, sharePath));
          const decoded = text(file.content);
          return {
            path: relative(sharePath),
            version: file.version,
            size: file.content.byteLength,
            encoding: decoded === undefined ? 'base64' : 'utf8',
            content: decoded ?? file.content.toString('base64'),
          };
        }
        case 'create':
        case 'update': {
          const bytes = decode(request);
          const info = await run(folder, (target) =>
            request.action === 'create'
              ? deps.client.create(target, sharePath, bytes)
              : deps.client.update(target, sharePath, bytes, request.expectedVersion),
          );
          deps.logWrite?.({
            projectId: input.projectId,
            sessionId: input.sessionId,
            folderId: folder.id,
            path: sharePath,
            action: request.action,
            bytes: bytes.byteLength,
          });
          return { path: relative(sharePath), version: info.version, size: info.size };
        }
      }
    },
  };
}
