import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { migrationProvider } from './migrations.js';
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

it.each([true, false])('returns an active incident beyond history, owned=%s', async (owned) => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const incident = await ctx.store.repairs.observe('a', 'pr:old', 'sha', '{}');
  if (owned) await ctx.store.repairs.claim(incident.id, 'worker', 1);
  await sql`update repair_incidents set updated_at=now()-interval '1 day' where id=${incident.id}`.execute(
    ctx.db,
  );
  await sql`insert into repair_incidents(id,project_id,resource,revision,evidence) select 'history-'||g,'a','pr:'||g,'sha','{}' from generate_series(1,205) g`.execute(
    ctx.db,
  );
  expect(
    (await ctx.store.repairs.incidents('a')).some(
      (i) => i.id === incident.id && i.owner_session_id === (owned ? 'worker' : null),
    ),
  ).toBe(true);
});

it('reopens a superseded revision when the PR returns to its failed SHA', async () => {
  const first = await ctx.store.repairs.observe('a', 'pr:1', 'old', '{}');
  await ctx.store.repairs.supersede('a', 'pr:1', 'new');
  const revived = await ctx.store.repairs.observe('a', 'pr:1', 'old', '{}');
  expect(revived.id).toBe(first.id);
  expect(revived.state).toBe('open');
});

describe('durable dispatch receipts', () => {
  async function reserve() {
    await ctx.store.repairs.configure('a', 'user', 'automatic');
    await ctx.store.createSession({
      sessionId: 'worker',
      projectId: 'a',
      worktree: '/wt/worker',
      model: 'm',
    });
    const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
    return (await ctx.store.repairs.claim(incident.id, 'worker', 1))!;
  }
  it('cancels an unstarted claim once, refunds its budget, and rejects delayed admission', async () => {
    const claim = await reserve();
    expect(await ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!)).toBe(true);
    expect(await ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!)).toBe(false);
    expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(0);
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'repair',
      }),
    ).toBeUndefined();
    expect(await ctx.store.getEvents('worker')).toEqual([]);
    expect((await ctx.store.repairs.incidents('a'))[0]?.owner_session_id).toBeNull();
  });
  it('commits acceptance with its prompt and recovery marker and never cancels admitted work', async () => {
    const claim = await reserve();
    const receipt = await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
      t: 'prompt',
      text: 'repair',
    });
    expect(receipt?.existing).toBe(false);
    expect(
      Number((await ctx.db.selectFrom('running_turns').selectAll().execute())[0]?.prompt_seq),
    ).toBe(receipt!.seq);
    expect(await ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!)).toBe(false);
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'duplicate',
      }),
    ).toMatchObject({ existing: true, seq: receipt!.seq });
    expect(await ctx.store.getEvents('worker')).toHaveLength(1);
    expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(1);
  });
  it('defers acceptance while the predecessor has no settlement proof', async () => {
    const claim = await reserve();
    await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: 0 });
    await expect(
      ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'repair',
      }),
    ).resolves.toBeUndefined();
    expect((await ctx.store.repairs.dispatchReceipt(claim.dispatch_id!))?.state).toBe('reserved');
    expect(await ctx.store.getEvents('worker')).toEqual([]);
  });
  it('replaces only a proven settled predecessor and ignores late cleanup', async () => {
    const claim = await reserve();
    const { seq } = await ctx.store.appendEvent('worker', { t: 'prompt', text: 'old' });
    await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: seq, markerId: 'old' });
    await ctx.store.appendEvent('worker', { t: 'status', state: 'completed' });
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'new',
      }),
    ).toBeUndefined();
    await ctx.store.confirmTurnSettled('worker', seq, 'wrong');
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'new',
      }),
    ).toBeUndefined();
    await ctx.store.confirmTurnSettled('worker', seq, 'old');
    const admitted = await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
      t: 'prompt',
      text: 'new',
    });
    expect(admitted?.existing).toBe(false);
    await ctx.store.clearRunningTurn('worker', seq, 'old');
    expect((await ctx.store.listRunningTurns())[0]?.promptSeq).toBe(admitted!.seq);
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'duplicate',
      }),
    ).toMatchObject({ existing: true });
  });

  it('rejects a late completion and delete after a resume reuses the same prompt anchor', async () => {
    const claim = await reserve();
    await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: 0, markerId: 'old' });
    await ctx.store.confirmTurnSettled('worker', 0, 'old');
    await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: 0, markerId: 'resumed' });
    await ctx.store.confirmTurnSettled('worker', 0, 'old');
    await ctx.store.clearRunningTurn('worker', 0, 'old');
    expect((await ctx.store.listRunningTurns())[0]?.markerId).toBe('resumed');
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'new',
      }),
    ).toBeUndefined();
  });

  it.each(['active', 'wrong-turn', 'wrong-session', 'fenced'] as const)(
    'requires exact Runner settlement: %s',
    async (mode) => {
      const claim = await reserve();
      await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: 0, markerId: 'runner' });
      await ctx.store.bindTurnIdentity('worker', {
        turnId: 'current-runner',
        startCommandId: 'start',
      });
      await ctx.store.confirmTurnSettled('worker', 0, 'runner');
      await ctx.store.appendEvent('worker', { t: 'interrupted' });
      if (mode === 'wrong-turn') await ctx.store.fenceAbandonedTurn('worker', 'other-runner');
      if (mode === 'wrong-session') {
        await ctx.store.createSession({ sessionId: 'other', worktree: '/wt/other', model: 'm' });
        await ctx.store.fenceAbandonedTurn('other', 'current-runner');
      }
      if (mode === 'fenced') await ctx.store.fenceAbandonedTurn('worker', 'current-runner');
      const admitted = await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'new',
      });
      expect(!!admitted).toBe(mode === 'fenced');
      if (!admitted)
        expect(
          (await ctx.store.listRunningTurns()).find((m) => m.sessionId === 'worker')?.turnId,
        ).toBe('current-runner');
    },
  );

  it('rolls back predecessor removal and prompt persistence if successor insertion fails', async () => {
    const claim = await reserve();
    await ctx.store.markTurnRunning({ sessionId: 'worker', promptSeq: 0, markerId: 'old' });
    await ctx.store.confirmTurnSettled('worker', 0, 'old');
    await sql`create function reject_qa_marker() returns trigger language plpgsql as $$ begin raise exception 'injected marker failure'; end $$`.execute(
      ctx.db,
    );
    await sql`create trigger reject_qa_marker before insert on running_turns for each row execute function reject_qa_marker()`.execute(
      ctx.db,
    );
    try {
      await expect(
        ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
          t: 'prompt',
          text: 'new',
        }),
      ).rejects.toThrow('injected marker failure');
      expect((await ctx.store.listRunningTurns())[0]?.markerId).toBe('old');
      expect(await ctx.store.getEvents('worker')).toEqual([]);
      expect((await ctx.store.repairs.dispatchReceipt(claim.dispatch_id!))?.state).toBe('reserved');
    } finally {
      await sql`drop trigger reject_qa_marker on running_turns`.execute(ctx.db);
      await sql`drop function reject_qa_marker()`.execute(ctx.db);
    }
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'new',
      }),
    ).toMatchObject({ existing: false });
  });

  it('serializes cancellation against admission so exactly one wins', async () => {
    const claim = await reserve();
    const [receipt, cancelled] = await Promise.all([
      ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'repair',
      }),
      ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!),
    ]);
    expect(Number(!!receipt) + Number(cancelled)).toBe(1);
    expect(await ctx.store.getEvents('worker')).toHaveLength(receipt ? 1 : 0);
    expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(receipt ? 1 : 0);
  });
  it('does not replay legacy or wrong-session acceptance', async () => {
    const claim = await reserve();
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'other', {
        t: 'prompt',
        text: 'repair',
      }),
    ).toBeUndefined();
    await sql`update qa_dispatches set state='legacy' where id=${claim.dispatch_id}`.execute(
      ctx.db,
    );
    expect(await ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!)).toBe(false);
    expect(
      await ctx.store.admitBackgroundDispatch(claim.dispatch_id!, 'worker', {
        t: 'prompt',
        text: 'repair',
      }),
    ).toBeUndefined();
  });
});

it('renews resource budgets only for a newly verified successful revision, preserving attempt history', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  for (let cycle = 0; cycle < 3; cycle++) {
    const incident = await ctx.store.repairs.observe('a', 'pr:1', 'failed-' + cycle, '{}');
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) expect(await ctx.store.repairs.retry(incident.id)).toBe(true);
      const claim = (await ctx.store.repairs.claim(incident.id, 'worker', 1))!;
      expect(claim).toBeDefined();
      await ctx.store.repairs.finishAttempt(claim.id, claim.dispatch_id!, 'verifying', '{}');
    }
    expect(await ctx.store.repairs.retry(incident.id)).toBe(false);
    if (cycle) {
      const oldGreen = (await ctx.store.repairs.incidents('a')).find(
        (i) => i.revision === 'green-0',
      )!;
      await ctx.store.repairs.resolve(oldGreen.id, oldGreen.revision);
      expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(2);
    }
    const green = await ctx.store.repairs.observe('a', 'pr:1', 'green-' + cycle, '{}');
    await ctx.store.repairs.resolve(green.id, 'wrong');
    expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(2);
    await ctx.store.repairs.resolve(green.id, green.revision);
    expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(0);
    expect(
      (await ctx.store.repairs.incidents('a')).find((i) => i.id === incident.id)?.attempts,
    ).toBe(2);
  }
  expect(await ctx.db.selectFrom('repair_attempts').selectAll().execute()).toHaveLength(6);
});

it('upgrades pre-receipt ownership conservatively and round-trips the recovery migration', async () => {
  await ctx.store.repairs.configure('a', 'user', 'automatic');
  const incident = await ctx.store.repairs.observe('a', 'pr:1', 'sha', '{}');
  const claim = (await ctx.store.repairs.claim(incident.id, 'worker', 1))!;
  await ctx.store.repairs.configureQA(true, 'admin');
  await ctx.store.repairs.qaSession('qa');
  const qa = (await ctx.store.repairs.qaClaim(1, '[]', 0))!;
  const migrator = new Migrator({ db: ctx.db, provider: migrationProvider });
  expect((await migrator.migrateTo('0173_qa_coordinator')).error).toBeUndefined();
  expect((await migrator.migrateToLatest()).error).toBeUndefined();
  expect((await ctx.store.repairs.dispatchReceipt(claim.dispatch_id!))?.state).toBe('legacy');
  expect((await ctx.store.repairs.dispatchReceipt(qa))?.state).toBe('legacy');
  expect(await ctx.store.repairs.cancelReservedDispatch(claim.dispatch_id!)).toBe(false);
  expect(await ctx.store.repairs.budgetUsed('a', 'pr:1')).toBe(1);
});
