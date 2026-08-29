import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createGhTokenCapabilityRegistry } from './github-token-broker.js';

const bindingA = { projectId: 'p1', owner: 'Heey-Global', repo: 'Verity' };
const bindingB = { projectId: 'p2', owner: 'acme', repo: 'widgets' };

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  await truncateAll(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

describe('createGhTokenCapabilityRegistry', () => {
  it('resolves an issued capability back to its exact binding', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const cap = await reg.issue(bindingA);
    expect(await reg.resolve(cap)).toEqual(bindingA);
  });

  it('persists and resolves the container generation for Unix-socket binding', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const binding = { ...bindingA, containerGeneration: 'generation-1' };
    const cap = await reg.issue(binding);
    expect(await reg.resolve(cap)).toEqual(binding);
    await expect(
      ctx.db
        .selectFrom('gh_token_capabilities')
        .select('container_generation')
        .where('project_id', '=', binding.projectId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ container_generation: 'generation-1' });
  });

  it('scopes each project to its own capability — one cannot resolve another', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const capA = await reg.issue(bindingA);
    const capB = await reg.issue(bindingB);
    expect(await reg.resolve(capA)).toEqual(bindingA);
    expect(await reg.resolve(capB)).toEqual(bindingB);
    expect(capA).not.toBe(capB);
  });

  it('returns undefined for an unknown or empty capability', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    await reg.issue(bindingA);
    expect(await reg.resolve('not-a-real-capability')).toBeUndefined();
    expect(await reg.resolve('')).toBeUndefined();
  });

  it('rotates the capability on re-issue — the old one stops resolving', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const first = await reg.issue(bindingA);
    const second = await reg.issue(bindingA);
    expect(first).not.toBe(second);
    expect(await reg.resolve(first)).toBeUndefined();
    expect(await reg.resolve(second)).toEqual(bindingA);
  });

  it('revokes a project capability so it no longer resolves', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const cap = await reg.issue(bindingA);
    await reg.revokeProject('p1');
    expect(await reg.resolve(cap)).toBeUndefined();
    // Revoking an unknown project is a no-op.
    await expect(reg.revokeProject('nope')).resolves.not.toThrow();
  });

  it('persists across registry instances (survives a server restart/redeploy)', async () => {
    // The bug this table fixes: an in-memory registry lost every binding on
    // restart, so a sandbox's capability 401'd after any redeploy. A fresh
    // registry over the same DB must still resolve a previously-issued capability.
    const issuer = createGhTokenCapabilityRegistry(ctx.db);
    const cap = await issuer.issue(bindingA);
    const afterRestart = createGhTokenCapabilityRegistry(ctx.db);
    expect(await afterRestart.resolve(cap)).toEqual(bindingA);
  });

  it('never stores the raw capability (only a hash is retained)', async () => {
    const reg = createGhTokenCapabilityRegistry(ctx.db);
    const cap = await reg.issue(bindingA);
    // A high-entropy base64url secret of at least 32 bytes.
    expect(cap).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // The persisted row holds only a hash — the raw secret never touches the DB,
    // so a dump cannot recover a usable capability.
    const row = await ctx.db
      .selectFrom('gh_token_capabilities')
      .selectAll()
      .where('project_id', '=', 'p1')
      .executeTakeFirstOrThrow();
    expect(row.cap_hash).not.toContain(cap);
    expect(row.cap_hash).toMatch(/^[0-9a-f]{64}$/);
    // resolve() is the only way back — a near-miss guess never works.
    expect(await reg.resolve(`${cap}x`)).toBeUndefined();
  });
});
