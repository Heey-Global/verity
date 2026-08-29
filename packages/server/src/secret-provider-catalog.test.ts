import { EventStore } from '@verity/store';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type {
  ProviderBindingRecord,
  RunGrantClaims,
  SecretAliasRecord,
} from '@verity/secret-contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createPostgresSecretProviderCatalog,
  SecretProviderCatalogError,
} from './secret-provider-catalog.js';

const PROJECT = 'project-1';
const TOKEN = 'dp.st.test-provider-token';
const binding: ProviderBindingRecord = {
  id: 'doppler-main',
  projectId: PROJECT,
  version: 1,
  provider: 'doppler',
  credentialRef: 'secretref:broker/doppler',
  dopplerProject: 'verity',
  dopplerConfig: 'development',
  state: 'active',
};
const alias: SecretAliasRecord = {
  id: 'github-api-token',
  projectId: PROJECT,
  version: 1,
  name: 'github-api-token',
  description: 'Token used by the restricted GitHub pilot.',
  binding: { id: binding.id, version: binding.version, provider: 'doppler' },
  providerKey: 'GITHUB_API_TOKEN',
  injection: { kind: 'env', target: 'GITHUB_TOKEN' },
  profile: { id: 'github-read', version: 1, policyHash: 'a'.repeat(64) },
  state: 'active',
};

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});
afterEach(async () => truncateAll(ctx.db));
afterAll(async () => ctx.close());

async function seedProject(): Promise<void> {
  await new EventStore(ctx.db).upsertProject({
    id: PROJECT,
    owner: 'heey-global',
    repo: 'verity',
    containerName: 'verity-heey-global--verity',
    state: 'active',
  });
}

describe('Postgres Secret Provider Catalog', () => {
  it('persists immutable mapping records without provider credentials', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);

    expect(await catalog.resolveBinding(binding, PROJECT)).toEqual(binding);
    expect(await catalog.resolveAlias(alias, PROJECT)).toEqual(alias);
    expect(await ctx.db.selectFrom('secret_provider_credentials').selectAll().execute()).toEqual(
      [],
    );
  });

  it('never exposes credential references or provider keys in list projections', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);

    const serialized = JSON.stringify({
      bindings: await catalog.listBindings(PROJECT),
      aliases: await catalog.listAliases(PROJECT),
    });
    expect(serialized).not.toContain('credentialRef');
    expect(serialized).not.toContain(binding.credentialRef);
    expect(serialized).not.toContain(alias.providerKey);
    expect(serialized).not.toContain(TOKEN);
  });

  it('treats concurrent identical alias creation as an idempotent retry', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);

    await expect(
      Promise.all([catalog.createAlias(alias), catalog.createAlias(alias)]),
    ).resolves.toEqual([undefined, undefined]);
    expect(await catalog.resolveAlias(alias, PROJECT)).toEqual(alias);
  });

  it('rejects cross-project references, unavailable bindings, and version collisions', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(
      catalog.provisionBinding({
        ...binding,
        credentialRef: 'secretref:projects/other/doppler/doppler-main',
      }),
    ).rejects.toThrow(/credential reference/);
    await expect(catalog.createAlias(alias)).rejects.toThrow(/binding is unavailable/);

    await catalog.provisionBinding(binding);
    await expect(
      catalog.provisionBinding({ ...binding, dopplerConfig: 'production' }),
    ).rejects.toBeInstanceOf(SecretProviderCatalogError);
  });

  it('accepts an identical binding retry without retaining either supplied credential', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await expect(catalog.provisionBinding(binding)).resolves.toBeUndefined();
    expect(await ctx.db.selectFrom('secret_provider_credentials').selectAll().execute()).toEqual(
      [],
    );
  });

  it('accepts concurrent identical first-time binding provisioning', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(
      Promise.all([catalog.provisionBinding(binding), catalog.provisionBinding(binding)]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(catalog.resolveBinding(binding, PROJECT)).resolves.toEqual(binding);
  });

  it('rejects a non-broker credential reference', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(
      catalog.provisionBinding({
        ...binding,
        credentialRef: 'secretref:projects/other/doppler/doppler-main',
      }),
    ).rejects.toThrow();
  });

  it('removes encrypted credentials when their project is deleted', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await ctx.db.deleteFrom('projects').where('id', '=', PROJECT).execute();
    expect(await ctx.db.selectFrom('secret_provider_credentials').selectAll().execute()).toEqual(
      [],
    );
  });

  it('does not require the secret cipher to provision mapping metadata', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(catalog.provisionBinding(binding)).resolves.toBeUndefined();
  });

  it('stores project/tool-scoped permissions and consumes one-time grants exactly once', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const permission = await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'once',
      grantedBy: 'actor-1',
    });
    expect(permission).toMatchObject({
      projectId: PROJECT,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'once',
      remainingUses: 1,
      state: 'active',
    });
    const input = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      now: new Date('2026-07-23T00:00:00Z'),
    };
    await expect(catalog.consumePermission(input)).resolves.toBe(true);
    await expect(catalog.consumePermission(input)).resolves.toBe(false);
  });

  it('rejects direct permissions for a missing binding', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(
      catalog.grantPermission({
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: 'GITHUB_TOKEN',
        toolId: 'github-read@1:' + 'a'.repeat(64),
        scope: 'once',
        grantedBy: 'actor-1',
      }),
    ).rejects.toThrow(/binding is unavailable/);
  });

  it('binds session permissions to the exact session and supports revocation', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const permission = await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'DATABASE_URL',
      toolId: 'database.migrate',
      scope: 'session',
      sessionId: 'session-1',
      grantedBy: 'actor-1',
    });
    const base = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'DATABASE_URL',
      toolId: 'database.migrate',
      now: new Date('2026-07-23T00:00:00Z'),
    };
    await expect(catalog.consumePermission({ ...base, sessionId: 'session-2' })).resolves.toBe(
      false,
    );
    await expect(catalog.consumePermission({ ...base, sessionId: 'session-1' })).resolves.toBe(
      true,
    );
    await expect(catalog.revokePermission(permission.id, PROJECT)).resolves.toBe(true);
    await expect(catalog.consumePermission({ ...base, sessionId: 'session-1' })).resolves.toBe(
      false,
    );
  });

  it('uses an older valid permission when a newer grant does not match', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'project',
      grantedBy: 'actor-1',
    });
    await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'session',
      sessionId: 'other-session',
      grantedBy: 'actor-1',
    });
    await expect(
      catalog.consumePermission({
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: 'GITHUB_TOKEN',
        toolId: 'github.create-release',
        sessionId: 'session-1',
        now: new Date('2026-07-23T00:00:00Z'),
      }),
    ).resolves.toBe(true);
  });

  it('authorizes real grant claims by binding, provider key, and exact tool profile', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);
    const toolId = `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`;
    await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: alias.providerKey,
      toolId,
      scope: 'once',
      grantedBy: 'actor-1',
    });
    const claims: RunGrantClaims = {
      protocolVersion: 1,
      grantId: 'grant-1',
      requestHash: 'b'.repeat(64),
      projectId: PROJECT,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      profile: alias.profile,
      aliases: [{ id: alias.id, version: alias.version }],
      providerBindings: [alias.binding],
      audience: 'verity-secret-job-executor',
      issuedAt: '2026-07-23T00:00:00Z',
      expiresAt: '2026-07-23T00:05:00Z',
      nonce: 'n'.repeat(32),
    };

    await expect(
      catalog.checkClaimsPermissions(claims, new Date('2026-07-23T00:00:58Z')),
    ).resolves.toBe(true);
    await expect(
      catalog.checkClaimsPermissions(claims, new Date('2026-07-23T00:00:59Z')),
    ).resolves.toBe(true);
    await expect(
      catalog.authorizeClaimsPermissions(claims, new Date('2026-07-23T00:01:00Z')),
    ).resolves.toBe(true);
    await expect(
      catalog.authorizeClaimsPermissions(claims, new Date('2026-07-23T00:01:01Z')),
    ).resolves.toBe(false);
  });

  it('rolls back one-time consumption when another requested permission is unavailable', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const common = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      toolId: 'github-read@1:' + 'a'.repeat(64),
    };
    await catalog.grantPermission({
      ...common,
      secretName: 'FIRST_TOKEN',
      scope: 'once',
      grantedBy: 'actor-1',
    });
    const now = new Date('2026-07-23T00:01:00Z');
    await expect(
      catalog.consumePermissions([
        { ...common, secretName: 'FIRST_TOKEN', now },
        { ...common, secretName: 'MISSING_TOKEN', now },
      ]),
    ).resolves.toBe(false);
    await expect(
      catalog.consumePermission({ ...common, secretName: 'FIRST_TOKEN', now }),
    ).resolves.toBe(true);
  });

  it('allows only one concurrent consumer of a one-time permission', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github-read@1:' + 'a'.repeat(64),
      scope: 'once',
      grantedBy: 'actor-1',
    });
    const input = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github-read@1:' + 'a'.repeat(64),
      now: new Date('2026-07-23T00:01:00Z'),
    };
    const results = await Promise.all([
      catalog.consumePermission(input),
      catalog.consumePermission(input),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('falls back to another one-time grant during concurrent consumption', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const permission = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github-read@1:' + 'a'.repeat(64),
      scope: 'once' as const,
      grantedBy: 'actor-1',
    };
    await catalog.grantPermission(permission);
    await catalog.grantPermission(permission);
    const input = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github-read@1:' + 'a'.repeat(64),
      now: new Date('2026-07-23T00:01:00Z'),
    };

    await expect(
      Promise.all([catalog.consumePermission(input), catalog.consumePermission(input)]),
    ).resolves.toEqual([true, true]);
    await expect(catalog.consumePermission(input)).resolves.toBe(false);
  });

  it('allows the same binding id and version in different projects without cross-resolution', async () => {
    await seedProject();
    const otherProject = 'project-2';
    await new EventStore(ctx.db).upsertProject({
      id: otherProject,
      owner: 'heey-global',
      repo: 'other',
      containerName: 'verity-heey-global--other',
      state: 'active',
    });
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    const otherBinding: ProviderBindingRecord = {
      ...binding,
      projectId: otherProject,
      credentialRef: 'secretref:broker/doppler',
      dopplerConfig: 'production',
    };
    await catalog.provisionBinding(binding);
    await catalog.provisionBinding(otherBinding);

    await expect(catalog.resolveBinding(binding, PROJECT)).resolves.toMatchObject({
      projectId: PROJECT,
      dopplerConfig: 'development',
    });
    await expect(catalog.resolveBinding(binding, otherProject)).resolves.toMatchObject({
      projectId: otherProject,
      dopplerConfig: 'production',
    });
  });

  it('revokes historical binding versions when the latest version is disabled', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);
    await catalog.provisionBinding({
      ...binding,
      version: 2,
      credentialRef: 'secretref:broker/doppler',
      state: 'disabled',
    });

    await expect(catalog.resolveBinding(binding, PROJECT)).resolves.toBeUndefined();
    const claims = {
      protocolVersion: 1 as const,
      grantId: 'grant-1',
      requestHash: 'b'.repeat(64),
      projectId: PROJECT,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      profile: alias.profile,
      aliases: [{ id: alias.id, version: alias.version }],
      providerBindings: [alias.binding],
      audience: 'verity-secret-job-executor' as const,
      issuedAt: '2026-07-23T00:00:00Z',
      expiresAt: '2026-07-23T00:05:00Z',
      nonce: 'n'.repeat(32),
    };
    await expect(catalog.checkClaimsPermissions(claims)).resolves.toBe(false);
    await expect(
      catalog.provisionBinding({
        ...binding,
        version: 2,
        credentialRef: 'secretref:broker/doppler',
        state: 'disabled',
      }),
    ).resolves.toBeUndefined();
    const reactivated = {
      ...binding,
      version: 3,
      credentialRef: 'secretref:broker/doppler',
    };
    await catalog.provisionBinding(reactivated);
    await expect(catalog.resolveBinding(binding, PROJECT)).resolves.toBeUndefined();
    await expect(catalog.resolveBinding(reactivated, PROJECT)).resolves.toMatchObject({
      version: 3,
      state: 'active',
    });
  });

  it('revokes historical alias versions when the latest version is disabled', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);
    await expect(catalog.resolveAliasesForProfile(alias.profile, PROJECT)).resolves.toEqual([
      alias,
    ]);
    await catalog.createAlias({ ...alias, version: 2, state: 'disabled' });
    await expect(
      catalog.createAlias({ ...alias, version: 2, state: 'disabled' }),
    ).resolves.toBeUndefined();
    await expect(
      catalog.grantDynamicPermission(
        { ...alias, version: 2, state: 'disabled' },
        {
          projectId: PROJECT,
          bindingId: binding.id,
          bindingVersion: binding.version,
          secretName: alias.providerKey,
          toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
          scope: 'once',
          grantedBy: 'actor-1',
        },
      ),
    ).rejects.toThrow(/alias is revoked/);
    await expect(catalog.resolveAliasesForProfile(alias.profile, PROJECT)).resolves.toEqual([]);
    const reactivated = { ...alias, version: 3 };
    await catalog.createAlias(reactivated);

    await expect(catalog.resolveAlias(alias, PROJECT)).resolves.toBeUndefined();
    await expect(catalog.resolveAliasesForProfile(alias.profile, PROJECT)).resolves.toEqual([
      reactivated,
    ]);
    await expect(catalog.resolveAlias(reactivated, PROJECT)).resolves.toMatchObject({
      version: 3,
      state: 'active',
    });
  });

  it('authorizes an empty permission request without touching the database', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await expect(catalog.consumePermissions([])).resolves.toBe(true);
  });

  it('provisions mapping metadata without a provider credential', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);

    await expect(catalog.provisionBinding(binding)).resolves.toBeUndefined();
    expect(await catalog.resolveBinding(binding, PROJECT)).toEqual(binding);
  });

  it('refuses to rewrite an existing alias version with different content', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);

    await expect(catalog.createAlias({ ...alias, description: 'quietly widened' })).rejects.toThrow(
      /secret alias could not be created/,
    );
    expect(await catalog.resolveAlias(alias, PROJECT)).toEqual(alias);
  });

  it('resolves only the aliases whose profile identity matches exactly', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);
    await catalog.createAlias({
      ...alias,
      id: 'other-profile',
      profile: { ...alias.profile, id: 'github-write' },
    });
    await catalog.createAlias({
      ...alias,
      id: 'other-version',
      profile: { ...alias.profile, version: 2 },
    });
    await catalog.createAlias({
      ...alias,
      id: 'other-policy',
      profile: { ...alias.profile, policyHash: 'b'.repeat(64) },
    });

    await expect(catalog.resolveAliasesForProfile(alias.profile, PROJECT)).resolves.toEqual([
      alias,
    ]);
  });

  it('refuses permissions with a malformed secret name or tool id', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const base = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'project' as const,
      grantedBy: 'actor-1',
    };

    for (const invalid of [
      { secretName: 'github_token' },
      { secretName: '1_TOKEN' },
      { secretName: 'GITHUB TOKEN' },
      { toolId: '' },
      { toolId: 'x'.repeat(257) },
    ]) {
      await expect(catalog.grantPermission({ ...base, ...invalid })).rejects.toThrow(
        /invalid secret permission$/,
      );
    }
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('refuses permissions whose scope contradicts its session or expiry', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const base = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      grantedBy: 'actor-1',
    };
    const future = new Date(Date.now() + 60_000).toISOString();

    for (const invalid of [
      { scope: 'session' as const },
      { scope: 'project' as const, sessionId: 'session-1' },
      { scope: 'timed' as const },
      { scope: 'once' as const, expiresAt: future },
    ]) {
      await expect(catalog.grantPermission({ ...base, ...invalid })).rejects.toThrow(
        /invalid secret permission scope/,
      );
    }
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('refuses a timed permission that is already expired or unparseable', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const base = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      scope: 'timed' as const,
      grantedBy: 'actor-1',
    };

    await expect(
      catalog.grantPermission({ ...base, expiresAt: '2000-01-01T00:00:00Z' }),
    ).rejects.toThrow(/invalid secret permission expiry/);
    await expect(catalog.grantPermission({ ...base, expiresAt: 'whenever' })).rejects.toThrow(
      /invalid secret permission expiry/,
    );
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('lists granted permissions with their scope details', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const base = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: 'GITHUB_TOKEN',
      toolId: 'github.create-release',
      grantedBy: 'actor-1',
    };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await catalog.grantPermission({ ...base, scope: 'project' });
    await catalog.grantPermission({ ...base, scope: 'session', sessionId: 'session-1' });
    await catalog.grantPermission({ ...base, scope: 'timed', expiresAt });
    await catalog.grantPermission({ ...base, scope: 'once' });

    const listed = await catalog.listPermissions(PROJECT);

    expect(listed).toHaveLength(4);
    const byScope = new Map(listed.map((permission) => [permission.scope, permission]));
    expect(byScope.get('project')).toMatchObject({ state: 'active', grantedBy: 'actor-1' });
    expect(byScope.get('project')).not.toHaveProperty('sessionId');
    expect(byScope.get('project')).not.toHaveProperty('expiresAt');
    expect(byScope.get('project')).not.toHaveProperty('remainingUses');
    expect(byScope.get('session')).toMatchObject({ sessionId: 'session-1' });
    expect(byScope.get('timed')).toMatchObject({ expiresAt: new Date(expiresAt).toISOString() });
    expect(byScope.get('once')).toMatchObject({ remainingUses: 1 });
    expect(await catalog.listPermissions('project-2')).toEqual([]);
  });

  it('grants a dynamic permission and persists the alias it was issued for', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const toolId = `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`;

    const permission = await catalog.grantDynamicPermission(alias, {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: alias.providerKey,
      toolId,
      scope: 'once',
      grantedBy: 'actor-1',
    });

    expect(permission).toMatchObject({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: alias.providerKey,
      toolId,
      scope: 'once',
      remainingUses: 1,
      state: 'active',
    });
    expect(await catalog.resolveAlias(alias, PROJECT)).toEqual(alias);
    await expect(
      catalog.consumePermission({
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: alias.providerKey,
        toolId,
        now: new Date(),
      }),
    ).resolves.toBe(true);
  });

  it('refuses a dynamic alias that does not match the permission it would authorize', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const valid = {
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: alias.providerKey,
      toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
      scope: 'once' as const,
      grantedBy: 'actor-1',
    };

    for (const mismatch of [
      { projectId: 'project-2' },
      { bindingId: 'other-binding' },
      { bindingVersion: 2 },
      { secretName: 'OTHER_KEY' },
      { toolId: `${alias.profile.id}@1:${'b'.repeat(64)}` },
    ]) {
      await expect(
        catalog.grantDynamicPermission(alias, { ...valid, ...mismatch }),
      ).rejects.toThrow(/dynamic alias does not match permission/);
    }
    expect(await catalog.resolveAlias(alias, PROJECT)).toBeUndefined();
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('refuses a dynamic alias that contradicts the stored version', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);

    await expect(
      catalog.grantDynamicPermission(
        { ...alias, injection: { kind: 'env', target: 'WIDER_TOKEN' } },
        {
          projectId: PROJECT,
          bindingId: binding.id,
          bindingVersion: binding.version,
          secretName: alias.providerKey,
          toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
          scope: 'once',
          grantedBy: 'actor-1',
        },
      ),
    ).rejects.toThrow(/secret alias could not be created/);
    expect(await catalog.resolveAlias(alias, PROJECT)).toEqual(alias);
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('refuses a dynamic permission whose binding was never provisioned', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);

    await expect(
      catalog.grantDynamicPermission(alias, {
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: alias.providerKey,
        toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
        scope: 'once',
        grantedBy: 'actor-1',
      }),
    ).rejects.toThrow(/permission binding is unavailable/);
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('refuses a dynamic permission whose scope contradicts its session', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);

    await expect(
      catalog.grantDynamicPermission(alias, {
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: alias.providerKey,
        toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
        scope: 'session',
        grantedBy: 'actor-1',
      }),
    ).rejects.toThrow(/invalid secret permission$/);
    expect(await catalog.resolveAlias(alias, PROJECT)).toBeUndefined();
    expect(await catalog.listPermissions(PROJECT)).toEqual([]);
  });

  it('denies claims that reference an alias the catalog does not know', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    const claims: RunGrantClaims = {
      protocolVersion: 1,
      grantId: 'grant-1',
      requestHash: 'b'.repeat(64),
      projectId: PROJECT,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      profile: alias.profile,
      aliases: [{ id: 'never-created', version: 1 }],
      providerBindings: [alias.binding],
      audience: 'verity-secret-job-executor',
      issuedAt: '2026-07-23T00:00:00Z',
      expiresAt: '2026-07-23T00:05:00Z',
      nonce: 'n'.repeat(32),
    };

    await expect(catalog.checkClaimsPermissions(claims)).resolves.toBe(false);
    await expect(catalog.authorizeClaimsPermissions(claims)).resolves.toBe(false);
  });

  it('denies claims for a known alias with no matching permission', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias(alias);
    const claims: RunGrantClaims = {
      protocolVersion: 1,
      grantId: 'grant-1',
      requestHash: 'b'.repeat(64),
      projectId: PROJECT,
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      profile: alias.profile,
      aliases: [{ id: alias.id, version: alias.version }],
      providerBindings: [alias.binding],
      audience: 'verity-secret-job-executor',
      issuedAt: '2026-07-23T00:00:00Z',
      expiresAt: '2026-07-23T00:05:00Z',
      nonce: 'n'.repeat(32),
    };

    await expect(catalog.checkClaimsPermissions(claims)).resolves.toBe(false);

    // A grant for a different tool profile must not satisfy these claims either.
    await catalog.grantPermission({
      projectId: PROJECT,
      bindingId: binding.id,
      bindingVersion: binding.version,
      secretName: alias.providerKey,
      toolId: 'github-write@1:' + 'a'.repeat(64),
      scope: 'project',
      grantedBy: 'actor-1',
    });
    await expect(catalog.checkClaimsPermissions(claims)).resolves.toBe(false);
    await expect(catalog.authorizeClaimsPermissions(claims)).resolves.toBe(false);
  });

  it('rejects a dynamic alias below an existing revocation version', async () => {
    await seedProject();
    const catalog = createPostgresSecretProviderCatalog(ctx.db);
    await catalog.provisionBinding(binding);
    await catalog.createAlias({ ...alias, version: 2, state: 'disabled' });

    await expect(
      catalog.grantDynamicPermission(alias, {
        projectId: PROJECT,
        bindingId: binding.id,
        bindingVersion: binding.version,
        secretName: alias.providerKey,
        toolId: `${alias.profile.id}@${String(alias.profile.version)}:${alias.profile.policyHash}`,
        scope: 'once',
        grantedBy: 'actor-1',
      }),
    ).rejects.toThrow(/alias is revoked/);
    await expect(catalog.resolveAlias(alias, PROJECT)).resolves.toBeUndefined();
  });
});
