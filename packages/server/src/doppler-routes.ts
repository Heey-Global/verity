import type { FastifyInstance } from 'fastify';
import {
  AmbiguousDopplerConnectionError,
  LEGACY_DOPPLER_CONNECTION_ID,
  DopplerConnectionUsageChangedError,
  DopplerConnectionTokenChangedError,
  type DopplerConnectionRecord,
  SealedError,
  type EventStore,
} from '@verity/store';
import { z } from 'zod';
import { listDopplerProjectSecretNames } from './doppler-secret-resolver.js';
import type { ServerDeps } from './server-deps.js';
import type {
  DopplerValidateResult,
  DopplerProjectSummary,
  DopplerConfigSummary,
} from './doppler-token.js';

export type DopplerRouteDeps = Pick<
  ServerDeps,
  | 'secretCipher'
  | 'dopplerCredentialReader'
  | 'dopplerValidate'
  | 'dopplerWorkplace'
  | 'dopplerListProjects'
  | 'dopplerListConfigs'
> & {
  eventStore?: Pick<EventStore, 'dopplerConnections'> | undefined;
  secretJobDopplerConnectionId?: string | undefined;
  listNames?: typeof listDopplerProjectSecretNames;
};

const connectionParams = z.object({ id: z.string().min(1).max(200) }).strict();
const labelSchema = z.string().trim().min(1).max(80);
const tokenSchema = z.string().trim().min(1).max(4096);
const addBody = z.object({ label: labelSchema, token: tokenSchema }).strict();
const patchBody = z
  .object({
    label: labelSchema.optional(),
    token: tokenSchema.optional(),
    confirmTokenReplacement: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => value.label !== undefined || value.token !== undefined);
const catalogDeletionBlocked =
  'Change the Secret Job catalog connection before deleting this connection.';
const deleteBody = z.object({ bindingIds: z.array(connectionParams.shape.id) }).strict();
const connectionQuery = z.object({ connectionId: z.string().min(1).max(200).optional() });

export function registerDopplerRoutes(app: FastifyInstance, deps: DopplerRouteDeps): void {
  // `POST /doppler/validate` — a "does this Doppler Service Account token actually
  // work" check the onboarding wizard's OPTIONAL Doppler step uses, against the
  // first connection holding a token. Requires the cipher UNSEALED (the token must
  // decrypt). It NEVER returns/logs the token: on success it optionally echoes a
  // SAFE project count; on failure a fixed, redacted message. Always resolves —
  // sealed/not-configured are `{ ok: false, error }`, not thrown errors.
  app.post('/doppler/validate', async (): Promise<DopplerValidateResult> => {
    if (deps.dopplerValidate === undefined) return { ok: false, error: 'not configured' };
    const resolved = await withDopplerAccountToken(undefined, deps.dopplerValidate, true);
    return 'error' in resolved ? { ok: false, error: resolved.error } : resolved.value;
  });

  // Shared account-token resolver for the Doppler LIST routes (#320, binding picker),
  // per connection (ADR 0031). Returns either the decrypted token or a redacted
  // failure envelope — NEVER throws for the sealed/not-configured cases. The token
  // itself never leaves this helper except as the argument to `use`; callers return
  // only NON-secret list data.
  const withDopplerAccountToken = async <T>(
    connectionId: string | undefined,
    use: (token: string) => Promise<T>,
    firstWithToken = false,
  ): Promise<{ value: T; connectionRevision?: string | null } | { error: string }> => {
    if (deps.secretCipher?.isSealed() === true) return { error: 'locked' };
    if (deps.dopplerCredentialReader === undefined) return { error: 'not configured' };
    const includeRevision = connectionId !== undefined;
    if (connectionId === undefined && deps.eventStore !== undefined) {
      const connections = await deps.eventStore.dopplerConnections.list();
      if (firstWithToken) {
        connectionId = connections.find((connection) => connection.hasToken)?.id;
      } else {
        if (connections.length > 1) return { error: new AmbiguousDopplerConnectionError().message };
        connectionId = connections[0]?.id;
      }
      if (connectionId === undefined) return { error: 'not configured' };
    }
    const connections = deps.eventStore?.dopplerConnections;
    const revision = connectionId && connections ? await connections.get(connectionId) : undefined;
    let credential: Uint8Array | undefined;
    try {
      credential = await deps.dopplerCredentialReader(connectionId);
    } catch (err) {
      if (err instanceof SealedError) return { error: 'locked' };
      throw err;
    }
    if (credential === undefined) return { error: 'not configured' };
    try {
      let token: string;
      try {
        token = new TextDecoder('utf-8', { fatal: true }).decode(credential).trim();
      } catch {
        return { error: 'not configured' };
      }
      if (token.length === 0 || token.includes('\0')) return { error: 'not configured' };
      const value = await use(token);
      if (!revision) return { value };
      const current = await connections!.get(revision.id);
      if (!current || current.tokenRevision !== revision.tokenRevision)
        return { error: new DopplerConnectionTokenChangedError().message };
      return includeRevision
        ? { value, connectionRevision: revision.tokenRevision ?? null }
        : { value };
    } finally {
      credential.fill(0);
    }
  };

  // `GET /doppler/projects?connectionId=` — list the connection's Doppler projects
  // for the binding picker (#320). The list is derived from the TRUSTED instance
  // token (decrypted here, unsealed-only), NOT from repo content — this is what
  // closes the confused-deputy. Never returns/logs the token; only NON-secret
  // `{ slug, name }` summaries. Without `connectionId`, only a single connection can answer.
  app.get(
    '/doppler/projects',
    async (
      request,
    ): Promise<
      { projects: DopplerProjectSummary[]; connectionRevision?: string | null } | { error: string }
    > => {
      if (deps.dopplerListProjects === undefined) return { error: 'not configured' };
      const query = connectionQuery.safeParse(request.query ?? {});
      if (!query.success) return { error: 'invalid connection' };
      try {
        const resolved = await withDopplerAccountToken(
          query.data.connectionId,
          deps.dopplerListProjects,
        );
        return 'error' in resolved
          ? resolved
          : {
              projects: resolved.value,
              ...(resolved.connectionRevision !== undefined
                ? { connectionRevision: resolved.connectionRevision }
                : {}),
            };
      } catch (err) {
        // The seam's throw is contractually redacted (fixed status-keyed message,
        // never the token/body).
        return { error: err instanceof Error ? err.message : 'could not list Doppler projects' };
      }
    },
  );

  // `GET /doppler/configs?project=<project>&connectionId=` — list a Doppler
  // project's configs for the binding picker (#320). Same trust model + redaction
  // contract as `/doppler/projects`. `project` is REQUIRED.
  app.get(
    '/doppler/configs',
    async (
      request,
    ): Promise<
      { configs: DopplerConfigSummary[]; connectionRevision?: string | null } | { error: string }
    > => {
      const query = connectionQuery
        .extend({ project: z.string().min(1) })
        .safeParse(request.query ?? {});
      if (!query.success)
        return {
          error:
            query.error.issues[0]?.path[0] === 'project'
              ? 'project is required'
              : 'invalid connection',
        };
      const { project, connectionId } = query.data;
      if (deps.dopplerListConfigs === undefined) return { error: 'not configured' };
      try {
        const resolved = await withDopplerAccountToken(connectionId, (token) =>
          deps.dopplerListConfigs!(token, project),
        );
        return 'error' in resolved
          ? resolved
          : {
              configs: resolved.value,
              ...(resolved.connectionRevision !== undefined
                ? { connectionRevision: resolved.connectionRevision }
                : {}),
            };
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'could not list Doppler configs' };
      }
    },
  );

  const store = deps.eventStore;
  if (store === undefined) return;

  /** A token is stored only once Doppler accepted it, with its workplace when readable. */
  const checkedToken = async (
    token: string,
  ): Promise<{ workplace: { slug: string | null; name: string | null } } | { error: string }> => {
    if (deps.secretCipher?.isSealed() === true) return { error: 'locked' };
    if (deps.dopplerValidate === undefined) return { error: 'Doppler validation is unavailable' };
    const result = await deps.dopplerValidate(token);
    if (!result.ok) return { error: result.error ?? 'Doppler rejected the token' };
    const workplace = await deps.dopplerWorkplace?.(token);
    if (!workplace?.slug)
      return {
        error: 'Could not verify the Doppler workplace. Use a token that identifies its workplace.',
      };
    return { workplace };
  };
  const connectionView = (connection: DopplerConnectionRecord, projectCount: number) => ({
    id: connection.id,
    label: connection.label,
    hasToken: connection.hasToken,
    workplaceSlug: connection.workplaceSlug,
    workplaceName: connection.workplaceName,
    createdAt: connection.createdAt.toISOString(),
    projectCount,
  });
  const listView = async () =>
    Promise.all(
      (await store.dopplerConnections.list()).map(async (connection) =>
        connectionView(connection, (await store.dopplerConnections.usage(connection.id)).length),
      ),
    );
  // The instance's Doppler connections (ADR 0031): administrator-only by the
  // paired route policy's default. Tokens never leave the store.
  app.get('/doppler/connections', async () => ({ connections: await listView() }));

  app.post('/doppler/connections', async (request, reply) => {
    const input = addBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    const checked = await checkedToken(input.data.token);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    try {
      const connection = await store.dopplerConnections.addRecord({
        label: input.data.label,
        token: input.data.token,
        workplace: checked.workplace,
        initializeLegacyCatalog: deps.secretJobDopplerConnectionId === LEGACY_DOPPLER_CONNECTION_ID,
      });
      return reply.code(201).send(connectionView(connection, 0));
    } catch (error) {
      if (error instanceof DopplerConnectionUsageChangedError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch('/doppler/connections/:id', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    const input = patchBody.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid Doppler connection' });
    const { id } = params.data;
    const { token, label, confirmTokenReplacement } = input.data;
    const patch = label === undefined ? {} : { label };
    try {
      if (token === undefined) {
        const updated = await store.dopplerConnections.updateRecord(id, patch);
        return updated === undefined
          ? reply.code(404).send({ error: 'Doppler connection not found' })
          : connectionView(updated, updated.projectCount);
      }
      if (!confirmTokenReplacement)
        return reply.code(409).send({
          error: 'Confirm token replacement. Members may need to reconnect their personal tokens.',
        });
      const connection = await store.dopplerConnections.get(id);
      if (connection === undefined)
        return reply.code(404).send({ error: 'Doppler connection not found' });
      const bindings = (await store.dopplerConnections.usage(id)).flatMap(
        (entry) => entry.bindings,
      );
      const checked = await checkedToken(token);
      if ('error' in checked) return reply.code(400).send({ error: checked.error });

      const catalogConfigs =
        id === deps.secretJobDopplerConnectionId
          ? await store.dopplerConnections.catalogConfigs()
          : undefined;
      if (catalogConfigs && (connection.hasToken || catalogConfigs.length > 0)) {
        const currentToken =
          connection.workplaceSlug === null
            ? await store.dopplerConnections.tokenBytes(id)
            : undefined;
        try {
          const currentWorkplace =
            connection.workplaceSlug ??
            (currentToken === undefined
              ? undefined
              : (await deps.dopplerWorkplace?.(currentToken.toString('utf8')))?.slug);
          if (!currentWorkplace)
            return reply.code(409).send({
              error:
                'Could not verify the existing Secret Job catalog workplace. Configure a new catalog connection and review its grants before resuming jobs.',
            });
          if (currentWorkplace !== checked.workplace.slug)
            return reply.code(409).send({
              error:
                'The Secret Job catalog connection must stay in its current Doppler workplace.',
            });
        } finally {
          currentToken?.fill(0);
        }
      }

      const listNames = deps.listNames ?? listDopplerProjectSecretNames;
      const configs = new Set([
        ...bindings.map((binding) => `${binding.dopplerProject}/${binding.dopplerConfig}`),
        ...(catalogConfigs ?? []),
      ]);
      for (const reference of configs) {
        const [dopplerProject, dopplerConfig] = reference.split('/');
        const bytes = Buffer.from(token, 'utf8');
        try {
          await listNames({
            dopplerProject: dopplerProject!,
            dopplerConfig: dopplerConfig!,
            token: bytes,
          });
        } catch {
          return reply
            .code(400)
            .send({ error: `The replacement token cannot read Doppler config ${reference}.` });
        } finally {
          bytes.fill(0);
        }
      }
      const updated = await store.dopplerConnections.updateRecord(
        id,
        { ...patch, token, workplace: checked.workplace },
        {
          bindingIds: bindings.map(({ id }) => id),
          tokenRevision: connection.tokenRevision ?? null,
          ...(catalogConfigs === undefined ? {} : { catalogConfigs }),
        },
      );
      return updated === undefined
        ? reply.code(404).send({ error: 'Doppler connection not found' })
        : connectionView(updated, updated.projectCount);
    } catch (error) {
      if (
        error instanceof DopplerConnectionUsageChangedError ||
        error instanceof DopplerConnectionTokenChangedError
      )
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // What deleting would remove, for the warning before it.
  app.get('/doppler/connections/:id/usage', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    if ((await store.dopplerConnections.get(params.data.id)) === undefined)
      return reply.code(404).send({ error: 'Doppler connection not found' });
    return {
      projects: await store.dopplerConnections.usage(params.data.id),
      ...(params.data.id === deps.secretJobDopplerConnectionId
        ? { deletionBlockedReason: catalogDeletionBlocked }
        : {}),
    };
  });

  // Deleting a connection in use is allowed: its bindings disappear from every
  // project, with the personal tokens and grants for them.
  app.delete('/doppler/connections/:id', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    if (params.data.id === deps.secretJobDopplerConnectionId)
      return reply
        .code(409)
        .send({ error: catalogDeletionBlocked, code: 'doppler_catalog_in_use' });
    const confirmation = deleteBody.safeParse(request.body ?? { bindingIds: [] });
    if (!confirmation.success)
      return reply.code(400).send({ error: 'invalid Doppler connection confirmation' });
    try {
      if (!(await store.dopplerConnections.remove(params.data.id, confirmation.data.bindingIds)))
        return reply.code(404).send({ error: 'Doppler connection not found' });
    } catch (error) {
      if (error instanceof DopplerConnectionUsageChangedError)
        return reply.code(409).send({ error: error.message });
      throw error;
    }
    return reply.code(204).send();
  });
}
