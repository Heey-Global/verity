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
  networkShareNeedsApproval,
  networkShareRequestSchema,
  type NetworkShareRequest,
} from './network-share-request.js';

import { createHash } from 'node:crypto';

import { withNetworkShareTarget } from './network-share-routes.js';
import {
  NetworkShareError,
  SmbClient,
  type NetworkShareClient,
  type SmbTarget,
} from './network-share-smb.js';
import {
  ControlPlaneSessionAuthorityError,
  ControlPlaneSessionToolError,
} from './session-handoff-tool.js';

/**
 * What an approval covers: the grants as the user saw them, the item, the
 * version it changes and, for a replace, the exact new bytes. Any other request
 * under the same card no longer matches.
 */
function approvalBinding(
  resolved: Required<Pick<Resolved, 'folder' | 'sharePath'>> & Resolved,
): string {
  const { request, folder, sharePath, destination } = resolved;
  return JSON.stringify({
    action: request.action,
    folderId: folder.id,
    revision: folder.revision,
    path: sharePath,
    ...('kind' in request ? { kind: request.kind } : {}),
    ...('expectedVersion' in request ? { expectedVersion: request.expectedVersion } : {}),
    ...('content' in request
      ? {
          content: createHash('sha256')
            .update(`${request.encoding ?? 'utf8'}:${request.content}`)
            .digest('hex'),
        }
      : {}),
    ...(destination === undefined
      ? {}
      : {
          destination: {
            folderId: destination.folder.id,
            revision: destination.folder.revision,
            path: destination.sharePath,
          },
        }),
  });
}

/** How much of a replacement's text the card previews; the full request stays available. */
const PREVIEW_CHARACTERS = 600;

/** The approval card's account of a change, in the user's terms. */
interface NetworkSharePresentation {
  action: 'update' | 'rename' | 'move' | 'delete';
  kind: 'file' | 'folder';
  /** The share's name in Verity. */
  share: string;
  /**
   * The share's name, then each folder down to the item. Kept as separate
   * names: a name may itself contain the separator a joined string would use,
   * and the card must not show a different place than the one approved.
   */
  location: string[];
  /** Where a rename or move puts the item, in the same form. */
  destination?: string[];
  /** A replacement's size and, when it is text, its beginning. */
  content?: { bytes: number; preview?: string };
}

/** The first `count` characters of `text`, without walking the rest of it. */
function firstCharacters(text: string, count: number): string {
  let result = '';
  let taken = 0;
  for (const character of text) {
    if (taken++ === count) break;
    result += character;
  }
  return result;
}

type NetworkShareLogAction = 'create' | 'update' | 'create_folder' | 'rename' | 'move' | 'delete';

type Input = { projectId: string; sessionId: string; turnId: string; request: unknown };

interface Resolved {
  request: NetworkShareRequest;
  folder?: ProjectNetworkShareFolderRecord;
  /** The path on the share: the granted folder joined with the request's path. */
  sharePath?: string;
  /** Where a rename or move puts the item, and the grant that covers it. */
  destination?: { folder: ProjectNetworkShareFolderRecord; sharePath: string };
}

function relativePath(path: string): string {
  try {
    return normalizeNetworkSharePath(path);
  } catch (error) {
    if (error instanceof InvalidNetworkSharePathError)
      throw new ControlPlaneSessionToolError(error.message);
    throw error;
  }
}

const READ_ONLY =
  'This project may only read this folder. An administrator can allow changes in project settings.';

function decode(request: { content: string; encoding?: 'utf8' | 'base64' | undefined }): Buffer {
  if (request.encoding !== 'base64') return Buffer.from(request.content, 'utf8');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.content) || request.content.length % 4 !== 0)
    throw new ControlPlaneSessionToolError('content is not valid base64');
  return Buffer.from(request.content, 'base64');
}

// Keep a byte order mark: dropped here, an update built from the text would
// silently remove it from the file while its version still matches.
function text(content: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    return undefined;
  }
}

/** How long agents leave saved sign-in details alone after the NAS refused them. */
export const SIGN_IN_PAUSE_MS = 5 * 60_000;

export function createNetworkShareTool(deps: {
  store: Pick<EventStore, 'getSession' | 'getProject' | 'networkShares'>;
  client: NetworkShareClient;
  isSealed?: () => boolean;
  /** Logs one change without its content or credentials. */
  logWrite?: (entry: {
    projectId: string;
    sessionId: string;
    folderId: string;
    path: string;
    /** Where a rename or move put the item. */
    toFolderId?: string;
    toPath?: string;
    action: NetworkShareLogAction;
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
    const relative = relativePath(request.path ?? '');
    const sharePath = [folder.path, relative].filter(Boolean).join('/');
    // Normalization already refuses `..`; this keeps the boundary explicit.
    if (!networkSharePathWithin(folder.path, sharePath))
      throw new ControlPlaneSessionAuthorityError('The path leaves the shared folder.');
    if ((request.action === 'read' || networkShareIsMutation(request)) && relative === '')
      throw new ControlPlaneSessionToolError(
        request.action === 'create_folder' || ('kind' in request && request.kind === 'folder')
          ? 'Name a folder inside the granted folder; the granted folder itself cannot be changed.'
          : 'Name a file inside the folder.',
      );
    if (networkShareIsMutation(request) && folder.accessMode !== 'read-write')
      throw new ControlPlaneSessionAuthorityError(READ_ONLY);
    if (
      request.action === 'delete' &&
      (request.kind === 'file') !== (request.expectedVersion !== undefined)
    )
      throw new ControlPlaneSessionToolError(
        request.kind === 'file'
          ? 'Deleting a file needs expectedVersion from your latest read of it.'
          : 'A folder has no version; leave out expectedVersion.',
      );
    let destination: Resolved['destination'];
    if (request.action === 'rename') {
      if (request.newName.includes('/') || request.newName.includes('\\'))
        throw new ControlPlaneSessionToolError(
          'newName is a name only; use move to change folders.',
        );
      const name = relativePath(request.newName);
      if (name === '') throw new ControlPlaneSessionToolError('newName names the item.');
      const parent = sharePath.split('/').slice(0, -1);
      destination = { folder, sharePath: [...parent, name].join('/') };
      // A change of letter case is a rename; the very same name is not.
      if (destination.sharePath === sharePath)
        throw new ControlPlaneSessionToolError('The item already has this name.');
    } else if (request.action === 'move') {
      const target =
        request.toFolderId === undefined || request.toFolderId === folder.id
          ? folder
          : await deps.store.networkShares.projectFolder(input.projectId, request.toFolderId);
      if (!target || target.stale)
        throw new ControlPlaneSessionAuthorityError(
          'The destination folder is not shared with the project (anymore). Call folders for the current list.',
        );
      if (target.accessMode !== 'read-write')
        throw new ControlPlaneSessionAuthorityError(READ_ONLY);
      // A move is one rename on the server; it cannot cross to another share.
      if (target.connectionId !== folder.connectionId)
        throw new ControlPlaneSessionToolError(
          'Files can only be moved between folders on the same network share.',
        );
      const to = relativePath(request.toPath);
      if (to === '')
        throw new ControlPlaneSessionToolError('toPath names the new place of the item.');
      destination = { folder: target, sharePath: [target.path, to].filter(Boolean).join('/') };
      if (!networkSharePathWithin(target.path, destination.sharePath))
        throw new ControlPlaneSessionAuthorityError('The destination leaves the shared folder.');
      if (networkSharePathWithin(sharePath, destination.sharePath))
        throw new ControlPlaneSessionToolError(
          sharePath.toLowerCase() === destination.sharePath.toLowerCase()
            ? 'The item is already there.'
            : 'A folder cannot be moved into itself.',
        );
    }
    if (networkShareIsMutation(request)) {
      // Grants are paths. Changing a folder that is or holds one would leave a
      // project without its folder or, worse, point the grant at other files;
      // creating one where a granted folder is missing would fill another
      // project's grant with files this agent chose.
      const granted = await deps.store.networkShares.grantedPaths(folder.connectionId);
      const touched = [sharePath, ...(destination ? [destination.sharePath] : [])];
      if (granted.some((path) => touched.some((item) => networkSharePathWithin(item, path))))
        throw new ControlPlaneSessionAuthorityError(
          'This path is, or contains, a folder shared with a project, so it cannot be created, renamed, moved or deleted here.',
        );
    }
    return { request, folder, sharePath, ...(destination === undefined ? {} : { destination }) };
  };

  // A NAS counts failed sign-ins and may block the server's address after a
  // few. Once the saved details are refused, agents stop retrying them for a
  // while; new details from an administrator form a new key at once.
  const refusedSignIns = new Map<string, number>();
  const signInKey = (connectionId: string, target: SmbTarget) =>
    createHash('sha256')
      .update(connectionId)
      .update('\0')
      .update(`${target.host}:${target.port ?? ''}/${target.share}`)
      .update('\0')
      .update(target.username)
      .update('\0')
      .update(target.password)
      .digest('hex');
  const signIn = async <T>(
    connectionId: string,
    target: SmbTarget,
    work: (target: SmbTarget) => Promise<T>,
  ): Promise<T> => {
    const key = signInKey(connectionId, target);
    const refusedAt = refusedSignIns.get(key);
    if (refusedAt !== undefined && Date.now() - refusedAt < SIGN_IN_PAUSE_MS)
      throw new NetworkShareError('sign_in_failed');
    refusedSignIns.delete(key);
    try {
      return await work(target);
    } catch (error) {
      if (error instanceof NetworkShareError && error.code === 'sign_in_failed')
        refusedSignIns.set(key, Date.now());
      throw error;
    }
  };

  const run = async <T>(
    folder: ProjectNetworkShareFolderRecord,
    work: (target: SmbTarget) => Promise<T>,
    /** Further grants the call relies on, such as a move's destination. */
    others: readonly ProjectNetworkShareFolderRecord[] = [],
  ): Promise<T> => {
    try {
      const result = await withNetworkShareTarget(deps, folder.connectionId, async (target) => {
        // The grant was made for one server and share; never follow a changed target.
        const current = await deps.store.networkShares.projectFolder(folder.projectId, folder.id);
        // The grant must still be the one this call was authorized against; a
        // downgrade between authorization and this point must stop a write.
        if (!current || current.stale || current.revision !== folder.revision) return undefined;
        for (const other of others) {
          const now = await deps.store.networkShares.projectFolder(other.projectId, other.id);
          if (!now || now.stale || now.revision !== other.revision) return undefined;
        }
        return { value: await signIn(folder.connectionId, target, work) };
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

    /** Reads and creating new things run under the grant; changing what exists asks the user. */
    async standing(input: Input): Promise<boolean> {
      const { request } = await resolve(input);
      return !networkShareNeedsApproval(request);
    },

    /** What an approval card binds to: the grants as the user saw them. */
    async snapshot(input: Input): Promise<string | undefined> {
      const resolved = await resolve(input);
      const { request, folder, sharePath } = resolved;
      if (!networkShareNeedsApproval(request) || !folder || sharePath === undefined)
        return undefined;
      return approvalBinding({ ...resolved, folder, sharePath });
    },

    /**
     * What the approval card shows, in words: where the item is, where a rename
     * or move puts it and, for a replace, the new content. Merged into the
     * card's input by the server; agents cannot supply it, as their requests
     * are strict.
     */
    async presentation(
      input: Input,
    ): Promise<{ networkShare: NetworkSharePresentation } | undefined> {
      const { request, folder, sharePath, destination } = await resolve(input);
      if (!networkShareNeedsApproval(request) || !folder || sharePath === undefined)
        return undefined;
      const location = (grant: ProjectNetworkShareFolderRecord, path: string) => [
        grant.connectionLabel,
        ...path.split('/').filter(Boolean),
      ];
      let content: NetworkSharePresentation['content'];
      if (request.action === 'update') {
        const bytes = decode(request);
        const decoded = text(bytes);
        content = {
          bytes: bytes.byteLength,
          // Cut whole characters: half a surrogate pair would end the preview garbled.
          ...(decoded === undefined
            ? {}
            : { preview: firstCharacters(decoded, PREVIEW_CHARACTERS) }),
        };
      }
      return {
        networkShare: {
          action: request.action,
          kind: 'kind' in request ? request.kind : 'file',
          share: folder.connectionLabel,
          location: location(folder, sharePath),
          ...(destination === undefined
            ? {}
            : { destination: location(destination.folder, destination.sharePath) }),
          ...(content === undefined ? {} : { content }),
        },
      };
    },

    async invoke(
      input: Input & { approvedByCard?: boolean; authorizationSnapshot?: string },
    ): Promise<unknown> {
      const resolved = await resolve(input);
      const { request, folder, sharePath, destination } = resolved;
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
      if (networkShareNeedsApproval(request)) {
        // The approval covered these grants; a changed grant needs a new approval.
        const expected = approvalBinding({ ...resolved, folder, sharePath });
        if (input.approvedByCard !== true || input.authorizationSnapshot !== expected)
          throw new ControlPlaneSessionAuthorityError(
            'Folder access changed since the approval. Ask again.',
          );
      }
      const relative = (path: string, within = folder) =>
        path.slice(within.path.length).replace(/^\//, '');
      const logChange = (action: NetworkShareLogAction, bytes = 0) =>
        deps.logWrite?.({
          projectId: input.projectId,
          sessionId: input.sessionId,
          folderId: folder.id,
          path: sharePath,
          ...(destination === undefined
            ? {}
            : { toFolderId: destination.folder.id, toPath: destination.sharePath }),
          action,
          bytes,
        });
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
          logChange(request.action, bytes.byteLength);
          return { path: relative(sharePath), version: info.version, size: info.size };
        }
        case 'create_folder': {
          await run(folder, (target) => deps.client.createFolder(target, sharePath));
          logChange('create_folder');
          return { path: relative(sharePath), kind: 'folder' };
        }
        case 'rename':
        case 'move': {
          if (!destination) throw new ControlPlaneSessionToolError('destination required');
          await run(
            folder,
            (target) => deps.client.rename(target, request.kind, sharePath, destination.sharePath),
            destination.folder === folder ? [] : [destination.folder],
          );
          logChange(request.action);
          return {
            folderId: destination.folder.id,
            path: relative(destination.sharePath, destination.folder),
            kind: request.kind,
          };
        }
        case 'delete': {
          await run(folder, (target) =>
            request.kind === 'file'
              ? deps.client.deleteFile(target, sharePath, request.expectedVersion!)
              : deps.client.deleteFolder(target, sharePath),
          );
          logChange('delete');
          return { path: relative(sharePath), kind: request.kind, deleted: true };
        }
      }
    },
  };
}

/** The tool as the server wires it: the real SMB client unless a test supplies one. */
export function createServerNetworkShareTool(
  deps: {
    eventStore: Pick<EventStore, 'getSession' | 'getProject' | 'networkShares'>;
    networkShareClient?: NetworkShareClient | undefined;
    secretCipher?: { isSealed(): boolean } | undefined;
  },
  log: { info(entry: object, message: string): void },
): ReturnType<typeof createNetworkShareTool> {
  return createNetworkShareTool({
    store: deps.eventStore,
    client: deps.networkShareClient ?? new SmbClient(),
    isSealed: () => deps.secretCipher?.isSealed() === true,
    logWrite: (entry) => log.info(entry, 'Agent changed a network share'),
  });
}
