import { createHash } from 'node:crypto';

import {
  executionProfileRefSchema,
  positiveVersionSchema,
  providerBindingRecordSchema,
  secretContractIdSchema,
} from '@verity/secret-contracts';
import { SealedError } from '@verity/store';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  SecretProviderCatalogError,
  type SecretProviderCatalog,
} from './secret-provider-catalog.js';
import {
  DopplerSecretResolutionError,
  type DopplerSecretNameLister,
} from './doppler-secret-resolver.js';

const projectParamsSchema = z.object({ projectId: secretContractIdSchema }).strict();
const permissionParamsSchema = z
  .object({ projectId: secretContractIdSchema, permissionId: z.uuid() })
  .strict();
const bindingBodySchema = z
  .object({
    id: secretContractIdSchema,
    version: positiveVersionSchema,
    dopplerProject: secretContractIdSchema,
    dopplerConfig: secretContractIdSchema,
    state: z.enum(['active', 'disabled', 'revocation_attention']).default('active'),
  })
  .strict();
const namesQuerySchema = z
  .object({ bindingId: secretContractIdSchema, version: z.coerce.number().int().positive() })
  .strict();
const permissionBodySchema = z
  .object({
    bindingId: secretContractIdSchema,
    bindingVersion: positiveVersionSchema,
    secretName: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    tool: executionProfileRefSchema,
    scope: z.enum(['once', 'session', 'timed', 'project']),
    sessionId: secretContractIdSchema.optional(),
    durationSeconds: z.number().int().positive().max(31_536_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.scope === 'session') !== (value.sessionId !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'session scope requires sessionId' });
    }
    if ((value.scope === 'timed') !== (value.durationSeconds !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'timed scope requires durationSeconds' });
    }
  });

/** Dynamic Doppler-name discovery and project/tool-scoped permission administration. */
export function registerSecretProviderRoutes(
  app: FastifyInstance,
  catalog: SecretProviderCatalog,
  listSecretNames: DopplerSecretNameLister,
  authorizeProject: (
    authorizationHeader: string | undefined,
    projectId: string,
  ) => string | undefined | Promise<string | undefined>,
): void {
  app.get('/projects/:projectId/secret-providers/doppler/bindings', async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid project id' });
    if (
      (await authorizeProject(request.headers.authorization, params.data.projectId)) === undefined
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send({ bindings: await catalog.listBindings(params.data.projectId) });
  });

  app.post('/projects/:projectId/secret-providers/doppler/bindings', async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = bindingBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid provider binding' });
    }
    if (
      (await authorizeProject(request.headers.authorization, params.data.projectId)) === undefined
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const input = body.data;
    try {
      await catalog.provisionBinding({
        ...input,
        projectId: params.data.projectId,
        provider: 'doppler',
        credentialRef: 'secretref:broker/doppler',
      });
      return reply.code(201).send({ binding: input });
    } catch (error) {
      if (error instanceof SealedError) {
        return reply.code(503).send({ error: 'secret store is sealed' });
      }
      if (error instanceof SecretProviderCatalogError) {
        return reply.code(409).send({ error: 'provider binding could not be provisioned' });
      }
      request.log.error({ err: error }, 'Secret provider provisioning failed');
      return reply.code(500).send({ error: 'internal server error' });
    }
  });

  app.get('/projects/:projectId/secret-names', async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const query = namesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: 'invalid secret-name request' });
    }
    if (
      (await authorizeProject(request.headers.authorization, params.data.projectId)) === undefined
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const binding = await catalog.resolveBinding(
      {
        id: query.data.bindingId,
        version: query.data.version,
        provider: 'doppler',
      },
      params.data.projectId,
    );
    if (binding === undefined || binding.projectId !== params.data.projectId) {
      return reply.code(404).send({ error: 'provider binding not found' });
    }
    try {
      return reply.send({
        names: await listSecretNames(providerBindingRecordSchema.parse(binding)),
      });
    } catch {
      return reply.code(502).send({ error: 'secret names unavailable' });
    }
  });

  app.get('/projects/:projectId/secret-permissions', async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid project id' });
    if (
      (await authorizeProject(request.headers.authorization, params.data.projectId)) === undefined
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.send({ permissions: await catalog.listPermissions(params.data.projectId) });
  });

  app.post('/projects/:projectId/secret-permissions', async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    const body = permissionBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid secret permission' });
    }
    const actorId = await authorizeProject(request.headers.authorization, params.data.projectId);
    if (actorId === undefined) return reply.code(403).send({ error: 'forbidden' });
    const expiresAt =
      body.data.durationSeconds === undefined
        ? undefined
        : new Date(Date.now() + body.data.durationSeconds * 1000).toISOString();
    try {
      const binding = await catalog.resolveBinding(
        { id: body.data.bindingId, version: body.data.bindingVersion, provider: 'doppler' },
        params.data.projectId,
      );
      if (binding === undefined || binding.state !== 'active') {
        return reply.code(409).send({ error: 'secret permission could not be granted' });
      }
      const names = await listSecretNames(providerBindingRecordSchema.parse(binding));
      if (!names.includes(body.data.secretName)) {
        return reply.code(409).send({ error: 'secret permission could not be granted' });
      }
      const aliasId = `doppler-${createHash('sha256')
        .update(
          [
            params.data.projectId,
            body.data.bindingId,
            String(body.data.bindingVersion),
            body.data.secretName,
            body.data.tool.id,
            String(body.data.tool.version),
            body.data.tool.policyHash,
          ].join('\0'),
        )
        .digest('hex')
        .slice(0, 32)}`;
      const alias = {
        id: aliasId,
        projectId: params.data.projectId,
        version: 1,
        name: body.data.secretName,
        description: 'Dynamically authorized Doppler secret.',
        binding: {
          id: body.data.bindingId,
          version: body.data.bindingVersion,
          provider: 'doppler',
        },
        providerKey: body.data.secretName,
        injection: { kind: 'env', target: body.data.secretName },
        profile: body.data.tool,
        state: 'active',
      } as const;
      const permission = await catalog.grantDynamicPermission(alias, {
        projectId: params.data.projectId,
        bindingId: body.data.bindingId,
        bindingVersion: body.data.bindingVersion,
        secretName: body.data.secretName,
        toolId: `${body.data.tool.id}@${String(body.data.tool.version)}:${body.data.tool.policyHash}`,
        scope: body.data.scope,
        ...(body.data.sessionId === undefined ? {} : { sessionId: body.data.sessionId }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        grantedBy: actorId,
      });
      return reply.code(201).send({ permission, alias: { id: aliasId, version: 1 } });
    } catch (error) {
      if (error instanceof DopplerSecretResolutionError) {
        return reply.code(502).send({ error: 'secret names unavailable' });
      }
      if (error instanceof SecretProviderCatalogError) {
        return reply.code(409).send({ error: 'secret permission could not be granted' });
      }
      request.log.error({ err: error }, 'Secret permission grant failed');
      return reply.code(500).send({ error: 'internal server error' });
    }
  });

  app.delete('/projects/:projectId/secret-permissions/:permissionId', async (request, reply) => {
    const params = permissionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid secret permission' });
    if (
      (await authorizeProject(request.headers.authorization, params.data.projectId)) === undefined
    ) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return (await catalog.revokePermission(params.data.permissionId, params.data.projectId))
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'secret permission not found' });
  });
}
