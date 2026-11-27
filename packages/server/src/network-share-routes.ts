import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  InvalidNetworkSharePathError,
  NetworkShareTargetChangedError,
  SealedError,
  normalizeNetworkSharePath,
  type EventStore,
  type NetworkShareConnectionRecord,
  type ProjectNetworkShareFolderRecord,
} from '@verity/store';
import { z } from 'zod';

import { NetworkShareError, type NetworkShareClient, type SmbTarget } from './network-share-smb.js';

const id = z.string().min(1).max(200);
const label = z.string().trim().min(1).max(100);
// smbclient reads USER as `user%password`; a `%` would split the name.
const username = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('%'), 'Usernames cannot contain %.');
const password = z.string().min(1).max(1024);
const accessMode = z.enum(['read-only', 'read-write']);
const address = z.string().trim().min(3).max(600);

const createBody = z.object({ label, address, username, password }).strict();
const updateBody = z
  .object({
    label: label.optional(),
    address: address.optional(),
    username: username.optional(),
    password: password.optional(),
  })
  .strict();
const browseQuery = z.object({ path: z.string().max(1024).optional() }).strict();
const grantBody = z
  .object({ connectionId: id, path: z.string().max(1024), accessMode: accessMode.optional() })
  .strict();
const accessBody = z.object({ accessMode }).strict();

const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$/;
const SHARE = /^[^\\/:*?"<>|]{1,80}$/;
const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 0x20 || character === '\u007f');

export class InvalidNetworkShareAddressError extends Error {
  constructor() {
    super('Enter the address as smb://server/shared-folder or \\\\server\\shared-folder.');
    this.name = 'InvalidNetworkShareAddressError';
  }
}

/**
 * The server and shared folder an address names, as Finder (`smb://nas/team`)
 * or Explorer (`\\nas\team`) write it. A path after the shared folder is not
 * part of the connection; projects choose folders inside it.
 */
export function parseNetworkShareAddress(input: string): {
  host: string;
  port: number | null;
  share: string;
} {
  const trimmed = input.trim();
  let rest: string;
  if (/^smb:\/\//i.test(trimmed)) rest = trimmed.slice(6);
  else if (trimmed.startsWith('\\\\')) rest = trimmed.slice(2).replaceAll('\\', '/');
  else rest = trimmed.replace(/^\/\//, '');
  const [authority, rawShare] = rest.split('/');
  if (!authority || !rawShare) throw new InvalidNetworkShareAddressError();
  if (authority.includes('@')) throw new InvalidNetworkShareAddressError();
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
  const host = match?.[1]?.toLowerCase();
  const port = match?.[2] === undefined ? null : Number(match[2]);
  let share: string;
  try {
    share = decodeURIComponent(rawShare);
  } catch {
    throw new InvalidNetworkShareAddressError();
  }
  if (
    !host ||
    !HOST.test(host) ||
    !SHARE.test(share) ||
    hasControlCharacter(share) ||
    (port !== null && (port < 1 || port > 65535))
  )
    throw new InvalidNetworkShareAddressError();
  return { host, port, share };
}

export function formatNetworkShareAddress(connection: {
  host: string;
  port: number | null;
  share: string;
}): string {
  return `smb://${connection.host}${connection.port === null ? '' : `:${connection.port}`}/${connection.share}`;
}

function connectionView(connection: NetworkShareConnectionRecord) {
  return {
    id: connection.id,
    label: connection.label,
    address: formatNetworkShareAddress(connection),
    username: connection.username,
    projectCount: connection.projectCount,
    createdAt: connection.createdAt.toISOString(),
  };
}

export function networkShareFolderView(folder: ProjectNetworkShareFolderRecord) {
  return {
    id: folder.id,
    connectionId: folder.connectionId,
    connectionLabel: folder.connectionLabel,
    path: folder.path,
    name: folder.name,
    accessMode: folder.accessMode,
    stale: folder.stale,
  };
}

function addressable(parent: string, name: string): boolean {
  try {
    normalizeNetworkSharePath(parent ? `${parent}/${name}` : name);
    return !name.includes('"');
  } catch {
    return false;
  }
}

/** The reply for an adapter failure: a stable code and a message without NAS internals. */
export function sendNetworkShareError(reply: FastifyReply, error: unknown) {
  if (error instanceof NetworkShareError) {
    const status =
      error.code === 'not_found' || error.code === 'share_not_found'
        ? 404
        : error.code === 'conflict' ||
            error.code === 'already_exists' ||
            error.code === 'restore_failed'
          ? 409
          : error.code === 'access_denied'
            ? 403
            : error.code === 'too_large'
              ? 413
              : error.code === 'not_a_file'
                ? 400
                : 502;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof NetworkShareTargetChangedError)
    return reply.code(409).send({ error: error.message, code: 'target_changed' });
  if (
    error instanceof InvalidNetworkSharePathError ||
    error instanceof InvalidNetworkShareAddressError
  )
    return reply.code(400).send({ error: error.message });
  throw error;
}

export interface NetworkShareRouteContext {
  store: Pick<EventStore, 'getProject' | 'networkShares'>;
  client: NetworkShareClient;
  /** Whether the secret store is sealed, so a share's password cannot be read. */
  isSealed?: () => boolean;
}

/** Runs `work` with a connection's decrypted target and erases the password afterwards. */
export async function withNetworkShareTarget<T>(
  ctx: Pick<NetworkShareRouteContext, 'store' | 'isSealed'>,
  connectionId: string,
  work: (target: SmbTarget, targetRevision: string) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.isSealed?.() === true) throw new SealedError();
  const credentials = await ctx.store.networkShares.credentials(connectionId);
  if (!credentials) return undefined;
  try {
    return await work(credentials, credentials.targetRevision);
  } finally {
    credentials.password.fill(0);
  }
}

/**
 * Settings › Connectors › Network shares and the folders projects may use.
 * Every route is for administrators except reading a project's folders, which
 * project readers may do (see paired-route-policy.ts).
 */
export function installNetworkShares(app: FastifyInstance, ctx: NetworkShareRouteContext): void {
  const shares = ctx.store.networkShares;

  app.get('/network-shares', async () => ({
    connections: (await shares.listConnections()).map(connectionView),
  }));

  app.post('/network-shares', async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid network share' });
    try {
      const target = parseNetworkShareAddress(body.data.address);
      const secret = Buffer.from(body.data.password);
      try {
        await ctx.client.test({ ...target, username: body.data.username, password: secret });
      } finally {
        secret.fill(0);
      }
      const created = await shares.createConnection({
        label: body.data.label,
        ...target,
        username: body.data.username,
        password: body.data.password,
      });
      reply.code(201);
      const saved = await shares.getConnection(created);
      if (!saved) return reply.code(404).send({ error: 'network share not found' });
      return connectionView(saved);
    } catch (error) {
      return sendNetworkShareError(reply, error);
    }
  });

  app.patch('/network-shares/:connectionId', async (request, reply) => {
    const params = z.object({ connectionId: id }).strict().safeParse(request.params);
    const body = updateBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: 'invalid network share' });
    const connectionId = params.data.connectionId;
    const existing = await shares.getConnection(connectionId);
    if (!existing) return reply.code(404).send({ error: 'network share not found' });
    try {
      const target =
        body.data.address === undefined ? undefined : parseNetworkShareAddress(body.data.address);
      // The stored password is only ever sent to the server it was entered for;
      // a new server needs it entered again.
      if (
        target !== undefined &&
        body.data.password === undefined &&
        (target.host !== existing.host.toLowerCase() ||
          target.port !== existing.port ||
          target.share.toLowerCase() !== existing.share.toLowerCase())
      )
        return reply.code(400).send({
          error: 'Enter the password again for a new address.',
          code: 'password_required',
        });
      const reaches =
        target !== undefined ||
        body.data.username !== undefined ||
        body.data.password !== undefined;
      if (reaches) {
        // New sign-in details or a new target are only saved once they work.
        await withNetworkShareTarget(ctx, connectionId, async (current) => {
          const secret =
            body.data.password === undefined ? current.password : Buffer.from(body.data.password);
          try {
            await ctx.client.test({
              ...current,
              ...target,
              ...(body.data.username === undefined ? {} : { username: body.data.username }),
              password: secret,
            });
          } finally {
            if (secret !== current.password) secret.fill(0);
          }
        });
      }
      await shares.updateConnection(connectionId, {
        ...(body.data.label === undefined ? {} : { label: body.data.label }),
        ...target,
        ...(body.data.username === undefined ? {} : { username: body.data.username }),
        ...(body.data.password === undefined ? {} : { password: body.data.password }),
      });
      const updated = await shares.getConnection(connectionId);
      if (!updated) return reply.code(404).send({ error: 'network share not found' });
      return connectionView(updated);
    } catch (error) {
      return sendNetworkShareError(reply, error);
    }
  });

  app.delete('/network-shares/:connectionId', async (request, reply) => {
    const params = z.object({ connectionId: id }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid network share' });
    if (!(await shares.deleteConnection(params.data.connectionId)))
      return reply.code(404).send({ error: 'network share not found' });
    return reply.code(204).send();
  });

  app.post('/network-shares/:connectionId/test', async (request, reply) => {
    const params = z.object({ connectionId: id }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid network share' });
    try {
      const tested = await withNetworkShareTarget(ctx, params.data.connectionId, async (target) => {
        await ctx.client.test(target);
        return true;
      });
      if (!tested) return reply.code(404).send({ error: 'network share not found' });
      return { ok: true };
    } catch (error) {
      if (error instanceof NetworkShareError)
        return { ok: false, code: error.code, error: error.message };
      throw error;
    }
  });

  // The folder picker: folders only, browsed on the server with the share's account.
  app.get('/network-shares/:connectionId/folders', async (request, reply) => {
    const params = z.object({ connectionId: id }).strict().safeParse(request.params);
    const query = browseQuery.safeParse(request.query ?? {});
    if (!params.success || !query.success)
      return reply.code(400).send({ error: 'invalid folder request' });
    try {
      const path = normalizeNetworkSharePath(query.data.path ?? '');
      const entries = await withNetworkShareTarget(ctx, params.data.connectionId, (target) =>
        ctx.client.list(target, path),
      );
      if (!entries) return reply.code(404).send({ error: 'network share not found' });
      return {
        path,
        folders: entries
          // Only folders Verity can address; others would fail once chosen.
          .filter((entry) => entry.kind === 'folder' && addressable(path, entry.name))
          .map((entry) => ({
            name: entry.name,
            path: path ? `${path}/${entry.name}` : entry.name,
          })),
      };
    } catch (error) {
      return sendNetworkShareError(reply, error);
    }
  });

  const projectParams = z.object({ id }).strict();
  const folderParams = z.object({ id, folderId: id }).strict();

  app.get('/projects/:id/network-shares/folders', async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid project id' });
    if (!(await ctx.store.getProject(params.data.id)))
      return reply.code(404).send({ error: 'project not found' });
    return {
      folders: (await shares.projectFolders(params.data.id)).map(networkShareFolderView),
    };
  });

  app.post('/projects/:id/network-shares/folders', async (request, reply) => {
    const params = projectParams.safeParse(request.params);
    const body = grantBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: 'invalid folder access' });
    if (!(await ctx.store.getProject(params.data.id)))
      return reply.code(404).send({ error: 'project not found' });
    try {
      const path = normalizeNetworkSharePath(body.data.path);
      // Granting proves the folder exists on the share's current target.
      const verified = await withNetworkShareTarget(
        ctx,
        body.data.connectionId,
        async (target, targetRevision) => {
          await ctx.client.list(target, path);
          return targetRevision;
        },
      );
      const connection = await shares.getConnection(body.data.connectionId);
      if (verified === undefined || !connection)
        return reply.code(404).send({ error: 'network share not found' });
      const folderId = await shares.grantFolder({
        projectId: params.data.id,
        connectionId: body.data.connectionId,
        path,
        name: path.split('/').at(-1) || connection.share,
        // Read only unless the administrator chose otherwise.
        accessMode: body.data.accessMode ?? 'read-only',
        // Bind the grant to the server and shared folder that were just checked.
        targetRevision: verified,
      });
      if (!folderId) return reply.code(404).send({ error: 'network share not found' });
      reply.code(201);
      return networkShareFolderView((await shares.projectFolder(params.data.id, folderId))!);
    } catch (error) {
      return sendNetworkShareError(reply, error);
    }
  });

  app.patch('/projects/:id/network-shares/folders/:folderId', async (request, reply) => {
    const params = folderParams.safeParse(request.params);
    const body = accessBody.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ error: 'invalid folder access' });
    if (!(await shares.setFolderAccess(params.data.id, params.data.folderId, body.data.accessMode)))
      return reply.code(404).send({ error: 'folder not found' });
    return networkShareFolderView(
      (await shares.projectFolder(params.data.id, params.data.folderId))!,
    );
  });

  app.delete('/projects/:id/network-shares/folders/:folderId', async (request, reply) => {
    const params = folderParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid folder' });
    if (!(await shares.removeFolder(params.data.id, params.data.folderId)))
      return reply.code(404).send({ error: 'folder not found' });
    return reply.code(204).send();
  });
}
