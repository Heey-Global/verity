import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QA_EMERGENCY_BRAKE_STARTS } from './project-qa.js';
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
  for (const id of ['a', 'b'])
    await ctx.store.upsertProject({
      id,
      owner: 'team',
      repo: id,
      containerName: id,
      state: 'active',
    });
  await ctx.store.repairs.configureQA(true, 'admin');
});

const qa = () => ctx.store.repairs.projectQA;
const repairs = () => ctx.store.repairs;

/** Uses up an incident's rounds the way the supervisor does: claim, finish, block. */
async function exhaust(incidentId: string, revision: number) {
  for (const n of [1, 2]) {
    const claim = await repairs().claim(incidentId, `s-${incidentId}-${n}`, revision);
    expect(claim).toBeDefined();
    await repairs().finishAttempt(incidentId, claim!.dispatch_id!, 'verifying', '{}');
    await repairs().retry(incidentId);
  }
  expect(await repairs().claim(incidentId, 's-extra', revision)).toBeUndefined();
  expect(await repairs().blockExhausted(incidentId)).toBe(true);
}

describe('project QA role', () => {
  it('keeps one role per project and recognises only its own session', async () => {
    for (const id of ['qa-a', 'qa-b', 'other'])
      await ctx.store.createSession({
        sessionId: id,
        projectId: id === 'qa-b' ? 'b' : 'a',
        worktree: `/tmp/${id}`,
        model: 'm',
      });
    await qa().ensureRole('a');
    await qa().ensureRole('a');
    expect(await qa().attachSession('a', 'qa-a')).toBe('qa-a');
    // A second session never replaces the attached one.
    expect(await qa().attachSession('a', 'other')).toBe('qa-a');
    await qa().ensureRole('b');
    await qa().attachSession('b', 'qa-b');
    expect((await qa().roleForSession('qa-a'))?.project_id).toBe('a');
    expect((await qa().roleForSession('qa-b'))?.project_id).toBe('b');
    expect(await qa().roleForSession('other')).toBeUndefined();
    expect(await qa().isQASession('other')).toBe(false);
    expect(await qa().isQASession('qa-b')).toBe(true);
  });

  it('reviews one project at a time per project, never while braked or switched off', async () => {
    await ctx.store.createSession({
      sessionId: 'qa-a',
      projectId: 'a',
      worktree: '/tmp/qa',
      model: 'm',
    });
    await qa().ensureRole('a');
    await qa().attachSession('a', 'qa-a');
    const revision = (await repairs().qa()).revision;
    const first = await qa().claimReview('a', revision, '[]', 0);
    expect(first).toBeDefined();
    expect(await qa().claimReview('a', revision, '[]', 0)).toBeUndefined();
    expect(await qa().finishReview('a', first!, 'decision-recorded')).toBe(true);
    await sql`update qa_coordinator set brake_at = now()`.execute(ctx.db);
    expect(await qa().claimReview('a', revision, '[]', 0)).toBeUndefined();
    await qa().releaseBrake();
    await repairs().configureQA(false, 'admin');
    expect(await qa().claimReview('a', revision + 1, '[]', 0)).toBeUndefined();
  });
});

describe('QA issues', () => {
  it('files each resource as one issue and repairs one incident per issue at a time', async () => {
    await repairs().configure('a', 'admin', 'automatic');
    const one = await repairs().observe('a', 'pr:1', 'sha1', '{}');
    const two = await repairs().observe('a', 'pr:2', 'sha2', '{}');
    const issues = await qa().issues('a');
    expect(issues.map((i) => i.key).sort()).toEqual(['pr:1', 'pr:2']);
    // QA found the same cause behind both: one issue, one repair.
    expect(await qa().group('a', [one.id, two.id])).toBe(true);
    expect(await qa().issues('a')).toHaveLength(1);
    expect(await repairs().claim(one.id, 's1', 1)).toBeDefined();
    expect(await repairs().claim(two.id, 's2', 1)).toBeUndefined();
  });

  it('never groups over a user decision or into two running repairs', async () => {
    await repairs().configure('a', 'admin', 'automatic');
    const one = await repairs().observe('a', 'pr:1', 'sha1', '{}');
    const two = await repairs().observe('a', 'pr:2', 'sha2', '{}');
    const three = await repairs().observe('a', 'pr:3', 'sha3', '{}');
    const taken = (await qa().issues('a')).find((i) => i.key === 'pr:2')!;
    await qa().stop('a', taken.id, 'beyond-mandate', 'mine');
    await qa().decide('a', taken.id, 'take_over');
    expect(await qa().group('a', [one.id, two.id])).toBe(false);
    expect((await qa().issue('a', taken.id))?.state).toBe('taken_over');
    expect(await repairs().claim(one.id, 's1', 1)).toBeDefined();
    expect(await repairs().claim(three.id, 's3', 1)).toBeDefined();
    expect(await qa().group('a', [one.id, three.id])).toBe(false);
    // Nothing moved: every incident keeps its own issue.
    expect(new Set((await repairs().incidents('a')).map((i) => i.issue_id)).size).toBe(3);
  });

  it('refuses to group incidents of another project', async () => {
    const one = await repairs().observe('a', 'pr:1', 'sha', '{}');
    const foreign = await repairs().observe('b', 'pr:1', 'sha', '{}');
    expect(await qa().group('a', [one.id, foreign.id])).toBe(false);
    expect((await repairs().incidents('b'))[0]?.issue_id).not.toBe(one.issue_id);
  });

  it('stops for the user after two rounds and continues only on their answer', async () => {
    await repairs().configure('a', 'admin', 'automatic');
    const incident = await repairs().observe('a', 'pr:7', 'sha', '{}');
    await exhaust(incident.id, 1);
    await qa().reconcile('a');
    const [stopped] = await qa().issues('a');
    expect(stopped?.state).toBe('needs_you');
    expect(stopped?.reason).toBe('rounds-exhausted');
    expect((await qa().takeUnnotified('a')).map((i) => i.id)).toEqual([stopped!.id]);
    expect(await qa().takeUnnotified('a')).toEqual([]);
    expect(await qa().decide('a', stopped!.id, 'another_round')).toBe(true);
    expect(await qa().roundsAllowed(incident.id)).toBe(3);
    expect(await repairs().claim(incident.id, 's-third', 1)).toBeDefined();
  });

  it('never repairs an issue the user took over, and reopens a deferred one on a new revision', async () => {
    await repairs().configure('a', 'admin', 'automatic');
    const first = await repairs().observe('a', 'pr:3', 'sha1', '{}');
    const [issue] = await qa().issues('a');
    await qa().stop('a', issue!.id, 'beyond-mandate', 'needs a migration');
    expect(await repairs().claim(first.id, 's1', 1)).toBeUndefined();
    expect(await qa().decide('a', issue!.id, 'take_over')).toBe(true);
    expect(await repairs().claim(first.id, 's1', 1)).toBeUndefined();

    const other = await repairs().observe('a', 'pr:4', 'sha1', '{}');
    const deferred = (await qa().issues('a')).find((i) => i.key === 'pr:4')!;
    await qa().stop('a', deferred.id, 'beyond-mandate', 'later');
    await qa().decide('a', deferred.id, 'defer');
    await repairs().observe('a', 'pr:4', 'sha1', '{"again":true}');
    expect((await qa().issue('a', deferred.id))?.state).toBe('deferred');
    await repairs().supersede('a', 'pr:4', 'sha2');
    await repairs().observe('a', 'pr:4', 'sha2', '{}');
    expect((await qa().issue('a', deferred.id))?.state).toBe('open');
    expect(other.issue_id).toBeDefined();
  });

  it('resolves an issue once none of its incidents is open', async () => {
    const incident = await repairs().observe('a', 'workflow:ci', 'sha', '{}');
    await repairs().resolve(incident.id, 'sha');
    await qa().reconcile('a');
    expect((await qa().issues('a'))[0]?.state).toBe('resolved');
  });
});

describe('emergency brake', () => {
  it('trips after too many repair starts in an hour and stops only QA repairs', async () => {
    await repairs().configure('a', 'admin', 'automatic');
    expect(await qa().checkBrake()).toBe(false);
    const seed = await repairs().observe('a', 'pr:99', 'sha', '{}');
    for (let n = 0; n < QA_EMERGENCY_BRAKE_STARTS; n++)
      await sql`insert into repair_attempts (dispatch_id, incident_id, session_id) values (${`d${n}`}, ${seed.id}, 's')`.execute(
        ctx.db,
      );
    expect(await qa().checkBrake()).toBe(true);
    expect(await qa().brake()).not.toBeNull();
    const incident = await repairs().observe('a', 'pr:1', 'sha', '{}');
    expect(await repairs().claim(incident.id, 's1', 1)).toBeUndefined();
    // A session repairing its own pull request is not QA's work and keeps going.
    await ctx.store.createSession({
      sessionId: 'origin',
      projectId: 'a',
      worktree: '/o',
      model: 'm',
    });
    await repairs().registerSessionOrigin('a', 'pr:1', 'origin');
    expect(await repairs().claimSessionRepair(incident.id, 'origin', 'marker')).toBeDefined();
    await qa().releaseBrake();
    expect(await qa().brake()).toBeNull();
    // The starts that tripped it do not trip it again right after the release.
    expect(await qa().checkBrake()).toBe(false);
  });
});
