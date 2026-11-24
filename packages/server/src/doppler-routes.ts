import type { FastifyInstance } from 'fastify';
import { SealedError, type EventStore } from '@verity/store';
import { z } from 'zod';
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
> & { eventStore?: Pick<EventStore, 'dopplerConnections'> | undefined };

const connectionParams = z.object({ id: z.string().min(1).max(200) }).strict();
const labelSchema = z.string().trim().min(1).max(80);
const tokenSchema = z.string().trim().min(1).max(4096);
const addBody = z.object({ label: labelSchema, token: tokenSchema }).strict();
const patchBody = z
  .object({ label: labelSchema.optional(), token: tokenSchema.optional() })
  .strict()
  .refine((value) => value.label !== undefined || value.token !== undefined);
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
    const resolved = await withDopplerAccountToken(undefined, deps.dopplerValidate);
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
  ): Promise<{ value: T } | { error: string }> => {
    if (deps.secretCipher?.isSealed() === true) return { error: 'locked' };
    if (deps.dopplerCredentialReader === undefined) return { error: 'not configured' };
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
      return { value: await use(token) };
    } finally {
      credential.fill(0);
    }
  };

  // `GET /doppler/projects?connectionId=` — list the connection's Doppler projects
  // for the binding picker (#320). The list is derived from the TRUSTED instance
  // token (decrypted here, unsealed-only), NOT from repo content — this is what
  // closes the confused-deputy. Never returns/logs the token; only NON-secret
  // `{ slug, name }` summaries. Without `connectionId`, the first connection
  // holding a token answers.
  app.get(
    '/doppler/projects',
    async (request): Promise<{ projects: DopplerProjectSummary[] } | { error: string }> => {
      if (deps.dopplerListProjects === undefined) return { error: 'not configured' };
      const query = connectionQuery.safeParse(request.query ?? {});
      if (!query.success) return { error: 'invalid connection' };
      try {
        const resolved = await withDopplerAccountToken(
          query.data.connectionId,
          deps.dopplerListProjects,
        );
        return 'error' in resolved ? resolved : { projects: resolved.value };
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
    async (request): Promise<{ configs: DopplerConfigSummary[] } | { error: string }> => {
      const query = request.query as { project?: unknown; connectionId?: unknown };
      const project = typeof query.project === 'string' ? query.project : '';
      if (project.length === 0) return { error: 'project is required' };
      const connectionId =
        typeof query.connectionId === 'string' && query.connectionId.length > 0
          ? query.connectionId
          : undefined;
      if (deps.dopplerListConfigs === undefined) return { error: 'not configured' };
      try {
        const resolved = await withDopplerAccountToken(connectionId, (token) =>
          deps.dopplerListConfigs!(token, project),
        );
        return 'error' in resolved ? resolved : { configs: resolved.value };
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
    if (deps.dopplerValidate !== undefined) {
      const result = await deps.dopplerValidate(token);
      if (!result.ok) return { error: result.error ?? 'Doppler rejected the token' };
    }
    return {
      workplace: (await deps.dopplerWorkplace?.(token)) ?? { slug: null, name: null },
    };
  };
  const listView = async () => {
    const connections = await store.dopplerConnections.list();
    return Promise.all(
      connections.map(async (connection) => ({
        id: connection.id,
        label: connection.label,
        hasToken: connection.hasToken,
        workplaceSlug: connection.workplaceSlug,
        workplaceName: connection.workplaceName,
        createdAt: connection.createdAt.toISOString(),
        projectCount: (await store.dopplerConnections.usage(connection.id)).length,
      })),
    );
  };

  // The instance's Doppler connections (ADR 0031): administrator-only by the
  // paired route policy's default. Tokens never leave the store.
  app.get('/doppler/connections', async () => ({ connections: await listView() }));

  app.post('/doppler/connections', async (request, reply) => {
    const input = addBody.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    const checked = await checkedToken(input.data.token);
    if ('error' in checked) return reply.code(400).send({ error: checked.error });
    const id = await store.dopplerConnections.add({
      label: input.data.label,
      token: input.data.token,
      workplace: checked.workplace,
    });
    reply.code(201);
    return (await listView()).find((connection) => connection.id === id);
  });

  app.patch('/doppler/connections/:id', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    const input = patchBody.safeParse(request.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid Doppler connection' });
    let workplace: { slug: string | null; name: string | null } | undefined;
    if (input.data.token !== undefined) {
      const checked = await checkedToken(input.data.token);
      if ('error' in checked) return reply.code(400).send({ error: checked.error });
      workplace = checked.workplace;
    }
    const updated = await store.dopplerConnections.update(params.data.id, {
      ...(input.data.label === undefined ? {} : { label: input.data.label }),
      ...(input.data.token === undefined ? {} : { token: input.data.token }),
      ...(workplace === undefined ? {} : { workplace }),
    });
    if (!updated) return reply.code(404).send({ error: 'Doppler connection not found' });
    return (await listView()).find((connection) => connection.id === params.data.id);
  });

  // What deleting would remove, for the warning before it.
  app.get('/doppler/connections/:id/usage', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    if ((await store.dopplerConnections.get(params.data.id)) === undefined)
      return reply.code(404).send({ error: 'Doppler connection not found' });
    return { projects: await store.dopplerConnections.usage(params.data.id) };
  });

  // Deleting a connection in use is allowed: its bindings disappear from every
  // project, with the personal tokens and grants for them.
  app.delete('/doppler/connections/:id', async (request, reply) => {
    const params = connectionParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid Doppler connection' });
    if (!(await store.dopplerConnections.remove(params.data.id)))
      return reply.code(404).send({ error: 'Doppler connection not found' });
    return reply.code(204).send();
  });
}
