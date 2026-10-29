import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, truncateAll, type TestDb } from './testing.js';
let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await truncateAll(ctx.db);
  for (const id of ['a', 'b', 'c'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
});
describe('repair ownership', () => {
  it('deduplicates observations without claiming successful completion', async () => {
    const first = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    const again = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{"latest":true}');
    expect(again.id).toBe(first.id);
    expect(again.state).toBe('open');
    await ctx.store.repairs.resolve(first.id, 'wrong-sha');
    expect((await ctx.store.repairs.incidents('a'))[0]?.state).toBe('open');
  });
  it('requires an automatic current mandate and enforces one owner per project', async () => {
    const one = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    const two = await ctx.store.repairs.observe('a', 'pr:2', 'sha', '{}');
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    expect(await ctx.store.repairs.claim(one.id, 's1', 1)).toBeUndefined();
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    expect(await ctx.store.repairs.claim(one.id, 's1', 1)).toBeUndefined();
    const results = await Promise.all([
      ctx.store.repairs.claim(one.id, 's1', 2),
      ctx.store.repairs.claim(two.id, 's2', 2),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('caps concurrent projects and never steals an owner on a retry', async () => {
    for (const project of ['a', 'b', 'c']) {
      await ctx.store.repairs.configure(project, 'user', 'automatic');
      const incident = await ctx.store.repairs.observe(project, 'pr:1', 'sha', '{}');
      const claim = await ctx.store.repairs.claim(incident.id, `s-${project}`, 1);
      expect(Boolean(claim)).toBe(project !== 'c');
      await ctx.store.repairs.retry(incident.id);
      expect((await ctx.store.repairs.incidents(project))[0]?.owner_session_id).toBe(
        project === 'c' ? null : `s-${project}`,
      );
    }
  });
  it('requires the dispatch identity to release work and limits attempts', async () => {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    const first = (await ctx.store.repairs.claim(incident.id, 's1', 1))!;
    await ctx.store.repairs.finishAttempt(first.id, 'wrong', 'verifying', '{}');
    expect((await ctx.store.repairs.incidents('a'))[0]?.state).toBe('working');
    await ctx.store.repairs.finishAttempt(first.id, first.dispatch_id!, 'verifying', '{}');
    await ctx.store.repairs.retry(first.id);
    const second = (await ctx.store.repairs.claim(first.id, 's1', 1))!;
    await ctx.store.repairs.finishAttempt(second.id, second.dispatch_id!, 'blocked', '{}');
    await ctx.store.repairs.retry(second.id);
    expect(await ctx.store.repairs.claim(second.id, 's1', 1)).toBeUndefined();
  });
});

describe('QA consent', () => {
  it('enrolls only coding projects in monitor and preserves explicit choices', async () => {
    await ctx.store.upsertProject({
      id: 'local',
      kind: 'local',
      owner: 'local',
      repo: 'notes',
      containerName: 'notes',
      state: 'active',
    });
    await ctx.store.upsertProject({
      id: 'control',
      kind: 'control_plane',
      owner: 'local',
      repo: 'control',
      containerName: 'control',
      state: 'active',
    });
    await ctx.store.repairs.configure('a', 'user', 'off');
    await ctx.store.repairs.configure('b', 'user', 'automatic');
    await ctx.store.repairs.seedQAMonitoring('admin');
    expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('off');
    expect((await ctx.store.repairs.mandate('b'))?.mode).toBe('automatic');
    expect((await ctx.store.repairs.mandate('c'))?.mode).toBe('monitor');
    expect(await ctx.store.repairs.mandate('local')).toBeUndefined();
    expect(await ctx.store.repairs.mandate('control')).toBeUndefined();
  });
  it('requires a current permission card and applies persistent consent once', async () => {
    await ctx.store.repairs.configureQA(true, 'admin');
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    await ctx.store.repairs.qaOffer('a', incident.id, 1, 1);
    const [proposal] = await ctx.store.repairs.qaProposals();
    expect(proposal).toBeDefined();
    expect(await ctx.store.repairs.qaApprove(proposal!.id, 'a', 'approver', true)).toBe(true);
    expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('automatic');
    expect((await ctx.store.repairs.mandate('a'))?.sponsor_user_id).toBe('approver');
    expect(await ctx.store.repairs.qaApprove(proposal!.id, 'a', 'approver', true)).toBe(false);
  });
  it('revokes old cards on project pause or global toggle', async () => {
    await ctx.store.repairs.configureQA(true, 'admin');
    await ctx.store.repairs.configure('a', 'user', 'monitor');
    const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    await ctx.store.repairs.qaOffer('a', incident.id, 1, 1);
    const [proposal] = await ctx.store.repairs.qaProposals();
    await ctx.store.repairs.configureQA(false, 'admin');
    await ctx.store.repairs.configureQA(true, 'admin');
    expect(await ctx.store.repairs.qaApprove(proposal!.id, 'a', 'approver', true)).toBe(false);
    expect((await ctx.store.repairs.mandate('a'))?.mode).toBe('monitor');
  });
  it('bounds wakes and consumes each decision atomically', async () => {
    await ctx.store.repairs.configureQA(true, 'admin');
    await ctx.store.repairs.qaSession('qa');
    for (let i = 0; i < 24; i++) {
      const id = await ctx.store.repairs.qaClaim(1, '[]', 0);
      expect(id).toBeDefined();
      expect(await ctx.store.repairs.qaFinish(id!, 'done')).toBe(true);
      expect(await ctx.store.repairs.qaFinish(id!, 'again')).toBe(false);
    }
    expect(await ctx.store.repairs.qaClaim(1, '[]', 0)).toBeUndefined();
  });
});
