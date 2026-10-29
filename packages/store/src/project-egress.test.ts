import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from './testing.js';
import {
  ProjectEgressStore,
  canonicalEgressTarget,
  egressGrantCovers,
  type EgressRequest,
} from './project-egress.js';
let ctx: Awaited<ReturnType<typeof createTestDb>>;
let store: ProjectEgressStore;
let now = 1_000;
const admin = '00000000-0000-4000-8000-000000000001';
const target = { host: 'Downloads.Example.com.', protocol: 'tcp' as const, port: 443 };
beforeAll(async () => {
  ctx = await createTestDb();
  store = new ProjectEgressStore(ctx.db, () => now);
  await sql`insert into users(id, role, status) values ('member', 'member', 'active')`.execute(
    ctx.db,
  );
  await sql`insert into projects(id, owner, repo, container_name, kind, state, overview_visible)
    values ('a', 'owner', 'a', 'a', 'local', 'absent', true), ('b', 'owner', 'b', 'b', 'local', 'absent', true)`.execute(
    ctx.db,
  );
  await sql`insert into project_memberships(project_id, user_id, can_read, can_execute, can_manage)
    values ('a', 'member', true, true, false)`.execute(ctx.db);
});
afterAll(async () => {
  await ctx.close();
});
it('canonicalizes exact targets and rejects URL or ambiguous syntax', () => {
  expect(canonicalEgressTarget(target).host).toBe('downloads.example.com');
  expect(canonicalEgressTarget({ ...target, host: '2001:4860:4860:0:0:0:0:8888' }).host).toBe(
    '2001:4860:4860::8888',
  );
  for (const host of [
    '127.1',
    '0x7f000001',
    '2130706433',
    'example.com/path',
    'a@b.com',
    '*.example.com',
    'example.com:443',
    'a.com?token=x',
    ' example.com',
    '[::1]',
    'fe80::1%eth0',
  ])
    expect(() => canonicalEgressTarget({ ...target, host })).toThrow();
});
it('serializes duplicate requests, rechecks authority and keeps project scope', async () => {
  const replies = await Promise.all([
    store.request('a', admin, target),
    store.request('a', 'member', target),
  ]);
  const request = replies[0] as EgressRequest;
  expect((replies[1] as EgressRequest).id).toBe(request.id);
  expect(Object.values((await store.read('a', admin)).requests)).toHaveLength(1);
  await expect(store.decide('a', 'member', request.id, 0, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
  await expect(store.decide('b', admin, request.id, 0, true)).rejects.toMatchObject({
    code: 'missing',
  });
  await store.decide('a', admin, request.id, 0, true);
  const policy = await store.read('a', admin);
  expect(egressGrantCovers(policy, target, now)).toBe(true);
  expect(egressGrantCovers(policy, { ...target, port: 80 }, now)).toBe(false);
  expect(egressGrantCovers(policy, { ...target, protocol: 'udp' }, now)).toBe(false);
  expect(egressGrantCovers(await store.read('b', admin), target, now)).toBe(false);
  await expect(store.decide('a', admin, request.id, 0, true)).rejects.toMatchObject({
    code: 'stale',
  });
  now += 3_600_000;
  expect(egressGrantCovers(policy, target, now)).toBe(false);
  expect(((await store.request('a', 'member', target)) as EgressRequest).id).toBe(request.id);
});
it('rejects stale cards after revocation and requires explicit reopening after denial', async () => {
  const policy = await store.read('a', admin);
  const pending = await store.reopen('a', admin, target, policy.revision);
  await store.revoke('a', admin, policy.grants[0]!.id, pending.revision);
  await expect(store.decide('a', admin, pending.id, pending.revision, true)).rejects.toMatchObject({
    code: 'stale',
  });
  const retry = await store.reopen('a', admin, target, (await store.read('a', admin)).revision);
  await store.decide('a', admin, retry.id, retry.revision, false);
  expect(((await store.request('a', 'member', target)) as EgressRequest).status).toBe('denied');
  expect(((await store.request('a', 'member', target)) as EgressRequest).id).toBe(retry.id);
  const reopened = await store.reopen('a', admin, target, (await store.read('a', admin)).revision);
  expect(reopened.id).not.toBe(retry.id);
  now += 300_000;
  await expect(
    store.decide('a', admin, reopened.id, reopened.revision, true),
  ).rejects.toMatchObject({ code: 'stale' });
});
it('rejects disabled managers and persists across store recreation', async () => {
  const pending = await store.reopen('a', admin, target, (await store.read('a', admin)).revision);
  await sql`update users set status = 'disabled' where id = ${admin}`.execute(ctx.db);
  await expect(store.decide('a', admin, pending.id, pending.revision, true)).rejects.toMatchObject({
    code: 'forbidden',
  });
  await sql`update users set status = 'active' where id = ${admin}`.execute(ctx.db);
  const restored = new ProjectEgressStore(ctx.db, () => now);
  expect(Object.values((await restored.read('a', admin)).requests)[0]!.id).toBe(pending.id);
  await sql`update project_memberships set can_manage = false where project_id = 'a' and user_id = ${admin}`.execute(
    ctx.db,
  );
  await expect(
    restored.decide('a', admin, pending.id, pending.revision, true),
  ).rejects.toMatchObject({ code: 'forbidden' });
});
