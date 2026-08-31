import Fastify from 'fastify';
import { SealedError } from '@verity/store';
import { describe, expect, it, vi } from 'vitest';

import {
  SecretProviderCatalogError,
  type SecretProviderCatalog,
} from './secret-provider-catalog.js';
import { DopplerSecretResolutionError } from './doppler-secret-resolver.js';
import { registerSecretProviderRoutes } from './secret-provider-routes.js';

const bindingBody = {
  id: 'doppler-main',
  version: 1,
  dopplerProject: 'verity',
  dopplerConfig: 'development',
  state: 'active',
};

function setup() {
  const provisionBinding = vi.fn<SecretProviderCatalog['provisionBinding']>(() =>
    Promise.resolve(),
  );
  const createAlias = vi.fn<SecretProviderCatalog['createAlias']>(() => Promise.resolve());
  const grantPermission = vi.fn<SecretProviderCatalog['grantPermission']>((input) =>
    Promise.resolve({
      ...input,
      id: '11111111-1111-4111-8111-111111111111',
      state: 'active',
      createdAt: '2026-07-23T00:00:00.000Z',
    }),
  );
  const grantDynamicPermission = vi.fn<SecretProviderCatalog['grantDynamicPermission']>(
    (_alias, input) => grantPermission(input),
  );
  const binding = {
    id: 'doppler-main',
    projectId: 'project-1',
    version: 1,
    provider: 'doppler' as const,
    credentialRef: 'secretref:broker/doppler',
    dopplerProject: 'verity',
    dopplerConfig: 'development',
    state: 'active' as const,
  };
  const resolveBinding = vi.fn<SecretProviderCatalog['resolveBinding']>(() =>
    Promise.resolve(binding),
  );
  const revokePermission = vi.fn<SecretProviderCatalog['revokePermission']>(() =>
    Promise.resolve(true),
  );
  const catalog: SecretProviderCatalog = {
    provisionBinding,
    createAlias,
    listBindings: vi.fn(() => Promise.resolve([])),
    listAliases: vi.fn(() => Promise.resolve([])),
    resolveAliasesForProfile: vi.fn(() => Promise.resolve([])),
    grantPermission,
    grantDynamicPermission,
    listPermissions: vi.fn(() => Promise.resolve([])),
    revokePermission,
    consumePermission: vi.fn(() => Promise.resolve(true)),
    consumePermissions: vi.fn(() => Promise.resolve(true)),
    checkClaimsPermissions: vi.fn(() => Promise.resolve(true)),
    authorizeClaimsPermissions: vi.fn(() => Promise.resolve(true)),
    resolveAlias: vi.fn(() => Promise.resolve(undefined)),
    resolveBinding,
  };
  const listNames = vi.fn(() => Promise.resolve(['DATABASE_URL', 'GITHUB_TOKEN']));
  const app = Fastify();
  registerSecretProviderRoutes(app, catalog, listNames, (header, projectId) =>
    header === 'Bearer valid' && projectId === 'project-1' ? 'actor-1' : undefined,
  );
  return {
    app,
    provisionBinding,
    createAlias,
    grantPermission,
    grantDynamicPermission,
    listNames,
    catalog,
    resolveBinding,
    revokePermission,
  };
}

describe('Secret Provider provisioning routes', () => {
  it('requires project authorization and never returns the credential', async () => {
    const { app, provisionBinding } = setup();
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/projects/project-1/secret-providers/doppler/bindings',
      payload: bindingBody,
    });
    expect(unauthorized.statusCode).toBe(403);

    const crossProject = await app.inject({
      method: 'POST',
      url: '/projects/project-2/secret-providers/doppler/bindings',
      headers: { authorization: 'Bearer valid' },
      payload: bindingBody,
    });
    expect(crossProject.statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/secret-providers/doppler/bindings',
      headers: { authorization: 'Bearer valid' },
      payload: bindingBody,
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('credential');
    expect(provisionBinding).toHaveBeenCalledOnce();
    await app.close();
  });

  it('lists dynamic Doppler names without values', async () => {
    const { app, listNames } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/secret-names?bindingId=doppler-main&version=1',
      headers: { authorization: 'Bearer valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ names: ['DATABASE_URL', 'GITHUB_TOKEN'] });
    expect(listNames).toHaveBeenCalledOnce();
    await app.close();
  });

  it('creates tool-scoped permissions with the selected duration', async () => {
    const { app, grantDynamicPermission } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/secret-permissions',
      headers: { authorization: 'Bearer valid' },
      payload: {
        bindingId: 'doppler-main',
        bindingVersion: 1,
        secretName: 'GITHUB_TOKEN',
        tool: { id: 'github-create-release', version: 1, policyHash: 'a'.repeat(64) },
        scope: 'session',
        sessionId: 'session-1',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      alias: { id: expect.stringMatching(/^doppler-[a-f0-9]{32}$/), version: 1 },
    });
    expect(grantDynamicPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        providerKey: 'GITHUB_TOKEN',
        injection: { kind: 'env', target: 'GITHUB_TOKEN' },
        profile: { id: 'github-create-release', version: 1, policyHash: 'a'.repeat(64) },
      }),
      expect.objectContaining({
        projectId: 'project-1',
        bindingId: 'doppler-main',
        bindingVersion: 1,
        secretName: 'GITHUB_TOKEN',
        toolId: `github-create-release@1:${'a'.repeat(64)}`,
        scope: 'session',
        sessionId: 'session-1',
        grantedBy: 'actor-1',
      }),
    );
    await app.close();
  });

  it('reports Doppler discovery failures as an upstream failure', async () => {
    const { app, listNames } = setup();
    listNames.mockRejectedValueOnce(
      new DopplerSecretResolutionError('Doppler secret resolution failed'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/secret-permissions',
      headers: { authorization: 'Bearer valid' },
      payload: {
        bindingId: 'doppler-main',
        bindingVersion: 1,
        secretName: 'GITHUB_TOKEN',
        tool: { id: 'github-create-release', version: 1, policyHash: 'a'.repeat(64) },
        scope: 'once',
      },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'secret names unavailable' });
    await app.close();
  });

  it('fails closed across invalid, unauthorized, missing, and revoked administration paths', async () => {
    const { app, listNames, resolveBinding, revokePermission } = setup();
    const auth = { authorization: 'Bearer valid' };

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-providers/doppler/bindings',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-providers/doppler/bindings',
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/projects/project-1/secret-providers/doppler/bindings',
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-names?bindingId=bad/id&version=0',
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
    resolveBinding.mockResolvedValueOnce(undefined);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-names?bindingId=doppler-main&version=1',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    listNames.mockRejectedValueOnce(new DopplerSecretResolutionError('unavailable'));
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-names?bindingId=doppler-main&version=1',
          headers: auth,
        })
      ).statusCode,
    ).toBe(502);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-permissions',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/projects/project-1/secret-permissions',
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/projects/project-1/secret-permissions',
          headers: auth,
          payload: { scope: 'once' },
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/projects/project-1/secret-permissions/not-a-uuid',
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/projects/project-1/secret-permissions/11111111-1111-4111-8111-111111111111',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/projects/project-1/secret-permissions/11111111-1111-4111-8111-111111111111',
          headers: auth,
        })
      ).statusCode,
    ).toBe(204);
    revokePermission.mockResolvedValueOnce(false);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/projects/project-1/secret-permissions/11111111-1111-4111-8111-111111111111',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);

    await app.close();
  });

  it('maps sealed, conflict, upstream, and internal failures without leaking causes', async () => {
    const payload = {
      bindingId: 'doppler-main',
      bindingVersion: 1,
      secretName: 'GITHUB_TOKEN',
      tool: { id: 'github-create-release', version: 1, policyHash: 'a'.repeat(64) },
      scope: 'once',
    };
    const auth = { authorization: 'Bearer valid' };

    for (const [error, expected] of [
      [new SealedError(), 503],
      [new SecretProviderCatalogError('private catalog cause'), 409],
      [new Error('private internal cause'), 500],
    ] as const) {
      const { app, provisionBinding } = setup();
      provisionBinding.mockRejectedValueOnce(error);
      const response = await app.inject({
        method: 'POST',
        url: '/projects/project-1/secret-providers/doppler/bindings',
        headers: auth,
        payload: bindingBody,
      });
      expect(response.statusCode).toBe(expected);
      expect(response.body).not.toContain(error.message);
      await app.close();
    }

    {
      const { app } = setup();
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/projects/project-1/secret-names?bindingId=doppler-main&version=1',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/projects/project-1/secret-permissions',
            payload,
          })
        ).statusCode,
      ).toBe(403);
      await app.close();
    }

    {
      const { app, resolveBinding } = setup();
      resolveBinding.mockResolvedValueOnce(undefined);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/projects/project-1/secret-permissions',
            headers: auth,
            payload,
          })
        ).statusCode,
      ).toBe(409);
      await app.close();
    }

    {
      const { app, listNames } = setup();
      listNames.mockResolvedValueOnce(['DATABASE_URL']);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/projects/project-1/secret-permissions',
            headers: auth,
            payload,
          })
        ).statusCode,
      ).toBe(409);
      await app.close();
    }

    for (const [error, expected] of [
      [new SecretProviderCatalogError('private permission cause'), 409],
      [new Error('private permission internal cause'), 500],
    ] as const) {
      const { app, grantDynamicPermission } = setup();
      grantDynamicPermission.mockRejectedValueOnce(error);
      const response = await app.inject({
        method: 'POST',
        url: '/projects/project-1/secret-permissions',
        headers: auth,
        payload,
      });
      expect(response.statusCode).toBe(expected);
      expect(response.body).not.toContain(error.message);
      await app.close();
    }
  });
});
