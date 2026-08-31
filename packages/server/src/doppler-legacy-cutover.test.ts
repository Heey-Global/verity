import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createIsolatedTestDb, type TestDb } from '@verity/store/testing';

import type { DockerClient } from './docker.js';
import {
  completeLegacyDopplerCutover,
  hasPendingLegacyDopplerCutover,
  quarantineLegacyDopplerContainers,
} from './doppler-legacy-cutover.js';
import type { Provisioner } from './provisioner.js';

describe('legacy Doppler cutover', () => {
  let ctx: TestDb | undefined;
  afterEach(async () => ctx?.close());

  const seed = async () => {
    ctx = await createIsolatedTestDb();
    await ctx.store.upsertProject({
      id: 'legacy-project',
      owner: 'heey-global',
      repo: 'legacy',
      containerName: 'legacy-container',
      state: 'active',
    });
    await ctx.store.updateProjectSettings('legacy-project', {
      dopplerToken: 'legacy-inline-fixture',
      dopplerTokenRef: 'env:LEGACY_DOPPLER_TOKEN',
      dopplerMintedToken: 'legacy-minted-fixture',
      dopplerMintedTokenSlug: 'old-slug',
      dopplerProject: 'cluster',
      dopplerConfig: 'production',
    });
    await sql`
      insert into doppler_legacy_cutovers (
        project_id, container_name, doppler_project, doppler_config, token_slug,
        manual_credential
      ) values ('legacy-project', 'legacy-container', 'cluster', 'production', 'old-slug', false)
    `.execute(ctx.db);
    return ctx;
  };

  it('removes credential-bearing containers before activation', async () => {
    const test = await seed();
    const stopContainer = vi.fn(async () => undefined);
    const removeContainer = vi.fn(async () => undefined);
    const docker = { stopContainer, removeContainer } as unknown as DockerClient;

    await expect(quarantineLegacyDopplerContainers(test.db, docker)).resolves.toBe(1);
    expect(stopContainer).toHaveBeenCalledWith('legacy-container');
    expect(removeContainer).toHaveBeenCalledWith('legacy-container');
    await expect(test.store.getProjectSettings('legacy-project')).resolves.toMatchObject({
      dopplerToken: null,
      dopplerTokenRef: null,
      dopplerMintedToken: null,
      dopplerMintedTokenSlug: 'old-slug',
    });
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(true);
  });

  it('revokes first, recreates cleanly, and zeroizes the broker credential', async () => {
    const test = await seed();
    const credential = Buffer.from('central-broker-fixture');
    const revoke = vi.fn(async () => undefined);
    const recreateContainer = vi.fn(async () => test.store.getProject('legacy-project'));
    const provisioner = { recreateContainer } as unknown as Provisioner;

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner,
        readCredential: () => Promise.resolve(credential),
        revoke,
      }),
    ).resolves.toBe(1);

    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'cluster', config: 'production', slug: 'old-slug' }),
    );
    expect(recreateContainer).toHaveBeenCalledWith('legacy-project', { confirmWarnings: true });
    expect(credential.every((byte) => byte === 0)).toBe(true);
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(false);
  });

  it('keeps the cutover pending when revocation fails', async () => {
    const test = await seed();
    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer: vi.fn() } as unknown as Provisioner,
        readCredential: () => Promise.resolve(Buffer.from('central-broker-fixture')),
        revoke: () => Promise.reject(new Error('upstream unavailable')),
      }),
    ).rejects.toThrow('upstream unavailable');
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(true);
  });

  it('defers revocation without preventing unlock when the broker identity is missing', async () => {
    const test = await seed();
    const recreateContainer = vi.fn();

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer } as unknown as Provisioner,
        readCredential: () => Promise.resolve(undefined),
        revoke: vi.fn(),
      }),
    ).resolves.toBe(0);

    expect(recreateContainer).not.toHaveBeenCalled();
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(true);
  });

  it('does not recreate absent projects while completing their revocation', async () => {
    const test = await seed();
    await sql`update projects set state = 'absent' where id = 'legacy-project'`.execute(test.db);
    const revoke = vi.fn(async () => undefined);
    const recreateContainer = vi.fn();

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer } as unknown as Provisioner,
        readCredential: () => Promise.resolve(Buffer.from('central-broker-fixture')),
        revoke,
      }),
    ).resolves.toBe(1);

    expect(revoke).toHaveBeenCalledOnce();
    expect(recreateContainer).not.toHaveBeenCalled();
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(false);
  });

  it('validates catalog mappings before deleting their legacy credential', async () => {
    const test = await seed();
    await sql`
      update doppler_legacy_cutovers
      set token_slug = null, manual_credential = false, catalog_credential = true
      where project_id = 'legacy-project'
    `.execute(test.db);
    await sql`
      insert into secret_provider_credentials (credential_ref, project_id, ciphertext)
      values ('secretref:legacy-catalog', 'legacy-project', 'encrypted-fixture')
    `.execute(test.db);
    await sql`
      insert into secret_provider_bindings (
        id, project_id, version, provider, credential_ref,
        doppler_project, doppler_config, state
      ) values (
        'legacy', 'legacy-project', 1, 'doppler', 'secretref:legacy-catalog',
        'cluster', 'production', 'active'
      )
    `.execute(test.db);
    const credential = Buffer.from('central-broker-fixture');
    const validateBinding = vi.fn(async () => undefined);

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: {
          recreateContainer: vi.fn(async () => test.store.getProject('legacy-project')),
        } as unknown as Provisioner,
        readCredential: () => Promise.resolve(credential),
        revoke: vi.fn(),
        validateBinding,
      }),
    ).resolves.toBe(1);

    expect(validateBinding).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'cluster', config: 'production' }),
    );
    expect(credential.every((byte) => byte === 0)).toBe(true);
    await expect(
      test.db.selectFrom('secret_provider_credentials').selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(
      test.db.selectFrom('secret_provider_bindings').select('credential_ref').execute(),
    ).resolves.toEqual([{ credential_ref: 'secretref:broker/doppler' }]);
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(false);
  });

  it('preserves catalog credentials when central broker validation fails', async () => {
    const test = await seed();
    await sql`
      update doppler_legacy_cutovers
      set token_slug = null, manual_credential = false, catalog_credential = true
      where project_id = 'legacy-project'
    `.execute(test.db);
    await sql`
      insert into secret_provider_credentials (credential_ref, project_id, ciphertext)
      values ('secretref:legacy-catalog', 'legacy-project', 'encrypted-fixture')
    `.execute(test.db);
    await sql`
      insert into secret_provider_bindings (
        id, project_id, version, provider, credential_ref,
        doppler_project, doppler_config, state
      ) values (
        'legacy', 'legacy-project', 1, 'doppler', 'secretref:legacy-catalog',
        'cluster', 'production', 'active'
      )
    `.execute(test.db);

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer: vi.fn() } as unknown as Provisioner,
        readCredential: () => Promise.resolve(Buffer.from('central-broker-fixture')),
        revoke: vi.fn(),
        validateBinding: () => Promise.reject(new Error('mapping unavailable')),
      }),
    ).rejects.toThrow('mapping unavailable');

    await expect(
      test.db.selectFrom('secret_provider_credentials').select('credential_ref').execute(),
    ).resolves.toEqual([{ credential_ref: 'secretref:legacy-catalog' }]);
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(true);
  });

  it('retains a shared Doppler credential until every referencing project validates', async () => {
    const test = await seed();
    await sql`
      update doppler_legacy_cutovers
      set token_slug = null, manual_credential = false, catalog_credential = true
      where project_id = 'legacy-project'
    `.execute(test.db);
    await test.store.upsertProject({
      id: 'shared-project',
      owner: 'heey-global',
      repo: 'shared',
      containerName: 'shared-container',
      state: 'active',
    });
    await sql`
      insert into doppler_legacy_cutovers (
        project_id, container_name, doppler_project, doppler_config,
        manual_credential, catalog_credential
      ) values ('shared-project', 'shared-container', 'other-cluster', 'production', false, true)
    `.execute(test.db);
    await sql`
      insert into secret_provider_credentials (credential_ref, project_id, ciphertext)
      values ('secretref:shared-catalog', 'legacy-project', 'encrypted-fixture')
    `.execute(test.db);
    await sql`
      insert into secret_provider_bindings (
        id, project_id, version, provider, credential_ref,
        doppler_project, doppler_config, state
      ) values
        (
          'legacy', 'legacy-project', 1, 'doppler', 'secretref:shared-catalog',
          'cluster', 'production', 'active'
        ),
        (
          'shared', 'shared-project', 1, 'doppler', 'secretref:shared-catalog',
          'other-cluster', 'production', 'active'
        )
    `.execute(test.db);

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: {
          recreateContainer: vi.fn(async (projectId: string) => test.store.getProject(projectId)),
        } as unknown as Provisioner,
        readCredential: () => Promise.resolve(Buffer.from('central-broker-fixture')),
        revoke: vi.fn(),
        validateBinding: ({ project }) =>
          project === 'other-cluster'
            ? Promise.reject(new Error('second mapping unavailable'))
            : Promise.resolve(),
      }),
    ).rejects.toThrow('second mapping unavailable');

    await expect(
      test.db.selectFrom('secret_provider_credentials').select('credential_ref').execute(),
    ).resolves.toEqual([{ credential_ref: 'secretref:shared-catalog' }]);
    await expect(
      test.db
        .selectFrom('secret_provider_bindings')
        .select(['project_id', 'credential_ref'])
        .orderBy('project_id')
        .execute(),
    ).resolves.toEqual([
      { project_id: 'legacy-project', credential_ref: 'secretref:broker/doppler' },
      { project_id: 'shared-project', credential_ref: 'secretref:shared-catalog' },
    ]);
  });

  it('single-flights concurrent completion requests', async () => {
    const test = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => gate);
    const recreateContainer = vi.fn(async () => test.store.getProject('legacy-project'));
    const input = {
      db: test.db,
      provisioner: { recreateContainer } as unknown as Provisioner,
      readCredential: () => Promise.resolve(Buffer.from('central-broker-fixture')),
      revoke,
    };

    const first = completeLegacyDopplerCutover(input);
    const second = completeLegacyDopplerCutover(input);
    expect(first).toBe(second);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(recreateContainer).toHaveBeenCalledTimes(1);
  });

  it('rebuilds manual-only projects without requiring a central credential', async () => {
    const test = await seed();
    await sql`
      update doppler_legacy_cutovers
      set token_slug = null, token_ref = 'env:EXTERNAL_DOPPLER_TOKEN', manual_credential = true
      where project_id = 'legacy-project'
    `.execute(test.db);
    const readCredential = vi.fn(async () => undefined);
    const recreateContainer = vi.fn(async () => test.store.getProject('legacy-project'));

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer } as unknown as Provisioner,
        readCredential,
        revoke: vi.fn(),
      }),
    ).resolves.toBe(1);

    expect(readCredential).not.toHaveBeenCalled();
    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(false);
    await expect(
      sql<{ token_ref: string; runtime_cutover: boolean; remediated: boolean }>`
        select token_ref, runtime_cutover_at is not null as runtime_cutover,
               credential_remediated_at is not null as remediated
        from doppler_legacy_cutovers where project_id = 'legacy-project'
      `.execute(test.db),
    ).resolves.toMatchObject({
      rows: [
        {
          token_ref: 'env:EXTERNAL_DOPPLER_TOKEN',
          runtime_cutover: true,
          remediated: false,
        },
      ],
    });
  });

  it('retains an unresolved tombstone for a historical minted token without a slug', async () => {
    const test = await seed();
    await sql`
      update doppler_legacy_cutovers
      set token_slug = null, token_ref = null, manual_credential = true
      where project_id = 'legacy-project'
    `.execute(test.db);
    const recreateContainer = vi.fn(async () => test.store.getProject('legacy-project'));

    await expect(
      completeLegacyDopplerCutover({
        db: test.db,
        provisioner: { recreateContainer } as unknown as Provisioner,
        readCredential: () => Promise.resolve(undefined),
        revoke: vi.fn(),
      }),
    ).resolves.toBe(1);

    await expect(hasPendingLegacyDopplerCutover(test.db)).resolves.toBe(false);
    await expect(
      sql<{ runtime_cutover: boolean; remediated: boolean }>`
        select runtime_cutover_at is not null as runtime_cutover,
               credential_remediated_at is not null as remediated
        from doppler_legacy_cutovers where project_id = 'legacy-project'
      `.execute(test.db),
    ).resolves.toMatchObject({ rows: [{ runtime_cutover: true, remediated: false }] });
  });
});
