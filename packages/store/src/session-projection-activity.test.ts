import type { AgentEvent } from '@verity/events';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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
  await ctx.store.createSession({ sessionId: 'conversation', worktree: '/wt/chat', model: 'm' });
  await ctx.store.createSession({ sessionId: 'empty', worktree: '/wt/empty', model: 'm' });
});

async function eventAt(event: AgentEvent, second: number): Promise<number> {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, second));
  await ctx.db
    .insertInto('events')
    .values({
      session_id: 'conversation',
      type: event.t,
      payload: JSON.stringify(event),
      created_at: at.toISOString(),
    })
    .execute();
  return at.getTime();
}

it('keeps message recency behind technical activity and excludes subagent text', async () => {
  const promptAt = await eventAt({ t: 'prompt', text: 'Continue' }, 1);
  expect(
    (await ctx.store.listSessionProjectionFacts(['conversation'], 0)).get('conversation'),
  ).toMatchObject({ lastMessageAt: promptAt });
  const replyAt = await eventAt({ t: 'text', delta: 'Done' }, 2);
  await eventAt({ t: 'thinking', blockId: 'thought', delta: 'Checking' }, 3);
  await eventAt({ t: 'text', delta: 'Child work', parentToolId: 'child' }, 4);
  await eventAt({ t: 'notice', text: 'Merged pull request' }, 5);
  await eventAt({ t: 'text', delta: '' }, 6);
  await eventAt({ t: 'prompt', text: '' }, 7);
  const technicalAt = await eventAt({ t: 'status', state: 'completed' }, 8);
  const facts = await ctx.store.listSessionProjectionFacts(['conversation', 'empty'], 0);
  expect(facts.get('conversation')).toMatchObject({
    lastMessageAt: replyAt,
    lastActivityAt: technicalAt,
    events: [],
  });
  expect(facts.get('empty')).toMatchObject({ lastMessageAt: null, lastActivityAt: null });
});

it('counts attachment-only prompts and follows prompt deletion', async () => {
  const replyAt = await eventAt({ t: 'text', delta: 'Earlier reply' }, 1);
  const attachmentAt = await eventAt(
    {
      t: 'prompt',
      text: '',
      attachments: [{ kind: 'image', id: 'a'.repeat(64), mediaType: 'image/png' }],
    },
    2,
  );
  expect(
    (await ctx.store.listSessionProjectionFacts(['conversation'], 0)).get('conversation'),
  ).toMatchObject({ lastMessageAt: attachmentAt });
  await ctx.db.deleteFrom('events').where('type', '=', 'prompt').execute();
  expect(
    (await ctx.store.listSessionProjectionFacts(['conversation'], 0)).get('conversation'),
  ).toMatchObject({ lastMessageAt: replyAt });
});

it('counts user workflow messages and ignores server-authored notices', async () => {
  const requestAt = await eventAt({ t: 'notice', role: 'operator', text: 'Transcribe this' }, 1);

  expect(
    (await ctx.store.listSessionProjectionFacts(['conversation'], 0)).get('conversation'),
  ).toMatchObject({ lastMessageAt: requestAt });
  await eventAt({ t: 'notice', role: 'agent', text: 'Code workspace restored.' }, 2);
  await eventAt({ t: 'notice', text: 'Transcript saved' }, 3);
  expect(
    (await ctx.store.listSessionProjectionFacts(['conversation'], 0)).get('conversation'),
  ).toMatchObject({ lastMessageAt: requestAt });
});
