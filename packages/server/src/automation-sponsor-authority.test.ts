import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AutomationSchedulerDeps } from './automation-scheduler.js';
import { createAuthTokenRegistry } from './auth.js';
import type { ProjectRuntime } from './project-runtime.js';
import { buildServer } from './server.js';

// Capture the scheduler callback composed by buildServer without starting a
// clock-driven run. The real executor and store still decide whether to run.
const scheduler = vi.hoisted(() => ({ deps: undefined as AutomationSchedulerDeps | undefined }));
vi.mock('./automation-scheduler.js', () => ({
  startAutomationScheduler: (deps: AutomationSchedulerDeps) => {
    scheduler.deps = deps;
    return { stop() {}, wake() {}, runOnce: async () => {} };
  },
}));

let ctx: TestDb;
beforeAll(async () => {
  ctx = await createTestDb();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAll(ctx.db);
  scheduler.deps = undefined;
});

// Exercise sponsor revocation through the actual scheduler/server composition.
for (const change of [
  'unchanged',
  'paused',
  'membership',
  'disabled-user',
  'execute',
  'lookup-error',
  'missing-sponsor',
  'local',
] as const) {
  const check = it;
  check(`revalidates automation sponsorship before a scheduled script: ${change}`, async () => {
    const store = ctx.store;
    await store.createProject({
      id: 'p',
      owner: '__local__',
      repo: 'p',
      kind: 'local',
      cloneDir: 'p',
      containerName: 'verity-p',
      state: 'active',
    });
    await store.createSession({
      sessionId: 's',
      projectId: 'p',
      worktree: '/work/p/s',
      model: 'test',
    });
    await sql`insert into users (id, role, status) values ('member', 'member', 'active')`.execute(
      ctx.db,
    );
    await sql`insert into project_memberships (project_id, user_id, can_read, can_execute, can_manage)
      values ('p', 'member', true, true, false)`.execute(ctx.db);
    expect(await store.hasProjectPermission('member', 'p', 'execute')).toBe(true);
    const automation = await store.setSessionAutomation({
      sessionId: 's',
      sponsorUserId: 'member',
      name: 'Synthetic check',
      prompt: 'Synthetic prompt',
      script: 'exit 0',
      schedule: { kind: 'interval', everyMinutes: 60 },
    });
    const runScript = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }));
    const dispatch = vi.fn(async () => ({ accepted: true }));
    const app = buildServer({
      eventStore: store,
      bus: new InMemoryEventBus(),
      conductor: { dispatchTurnWhenIdle: dispatch } as unknown as Conductor,
      authRegistry: await createAuthTokenRegistry(store, { enabled: change !== 'local' }),
      projectCloneRoot: '/work',
      projectRuntime: { runAutomationScript: runScript } as unknown as ProjectRuntime,
    });
    try {
      await app.ready();
      if (change === 'missing-sponsor' || change === 'local') {
        automation.sponsorUserId = null;
        await ctx.db
          .updateTable('session_automations')
          .set({ sponsor_user_id: null })
          .where('id', '=', automation.id)
          .execute();
      }
      if (change === 'lookup-error')
        vi.spyOn(store, 'hasProjectPermission').mockRejectedValue(new Error('lookup unavailable'));
      if (change === 'execute')
        await sql`update project_memberships set can_execute = false where project_id = 'p' and user_id = 'member'`.execute(
          ctx.db,
        );
      if (change === 'paused')
        await ctx.db
          .updateTable('session_automations')
          .set({ status: 'paused' })
          .where('session_id', '=', 's')
          .execute();
      if (change === 'membership')
        await sql`delete from project_memberships where project_id = 'p' and user_id = 'member'`.execute(
          ctx.db,
        );
      if (change === 'disabled-user')
        await sql`update users set status = 'disabled' where id = 'member'`.execute(ctx.db);
      if (change === 'membership' || change === 'disabled-user')
        expect(await store.hasProjectPermission('member', 'p', 'execute')).toBe(false);
      expect(scheduler.deps).toBeDefined();
      const result = await scheduler.deps!.run(automation);
      expect(dispatch).not.toHaveBeenCalled();
      if (change === 'unchanged' || change === 'local') {
        expect(result.outcome).toBe('ok');
        expect(runScript).toHaveBeenCalledOnce();
      } else {
        expect(runScript).not.toHaveBeenCalled();
      }
    } finally {
      await app.close();
    }
  });
}
