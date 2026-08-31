import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../packages/store/src/testing.js';

const enabled = process.env.VERITY_SEARCH_PERF_SPIKE === '1';
const describeSpike = enabled ? describe : describe.skip;
const sessions = Number(process.env.VERITY_SEARCH_SPIKE_SESSIONS ?? 100);
const exchangesPerSession = Number(process.env.VERITY_SEARCH_SPIKE_EXCHANGES ?? 100);
const iterations = Number(process.env.VERITY_SEARCH_SPIKE_ITERATIONS ?? 30);
for (const [name, value] of [
  ['VERITY_SEARCH_SPIKE_SESSIONS', sessions],
  ['VERITY_SEARCH_SPIKE_EXCHANGES', exchangesPerSession],
  ['VERITY_SEARCH_SPIKE_ITERATIONS', iterations],
] as const) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
const projectCount = Math.min(4, sessions);
const targetSession = Math.min(42, sessions - 1);
const targetExchange = Math.min(42, exchangesPerSession - 1);
const targetProjectIndex = targetSession % projectCount;
const targetProject = `project-${targetProjectIndex}`;
const exactNeedle = `needleS${targetSession}E${targetExchange}`;
const messagesPerSession = exchangesPerSession * 2;
const targetProjectSessions = Math.floor((sessions - 1 - targetProjectIndex) / projectCount) + 1;

const vocabulary = [
  'authentication',
  'migration',
  'database',
  'compatibility',
  'projection',
  'interface',
  'transaction',
  'workflow',
  'repository',
  'validation',
  'component',
  'background',
  'deployment',
  'permission',
  'configuration',
  'resumable',
  'implementation',
  'performance',
  'diagnostic',
  'behavior',
];

function realisticText(seed: number, unique: string, role: 'user' | 'agent'): string {
  // 60% short, 30% medium, 10% long. The resulting corpus models routine prompts,
  // explanations, and occasional pasted diagnostics without random/non-repeatable data.
  const bucket = seed % 10;
  const words = bucket < 6 ? 24 : bucket < 9 ? 120 : 480;
  const content: string[] = [role === 'user' ? 'Please' : 'I', unique];
  for (let index = 0; index < words; index += 1) {
    content.push(vocabulary[(seed * 7 + index * 11) % vocabulary.length]!);
  }
  return `${content.join(' ')}.`;
}

interface Sample {
  p50Ms: number;
  p95Ms: number;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

async function sample(run: () => Promise<unknown>): Promise<Sample> {
  const values: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await run();
    values.push(performance.now() - started);
  }
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
  };
}

describeSpike('global chat search performance spike', () => {
  let ctx: TestDb;

  beforeAll(async () => {
    ctx = await createTestDb();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it(
    'measures cold projection storage and warm scoped searches',
    async () => {
      for (let project = 0; project < projectCount; project += 1) {
        await ctx.store.upsertProject({
          id: `project-${project}`,
          owner: 'verity-spike',
          repo: `repository-${project}`,
          containerName: `verity-spike-${project}`,
          state: 'active',
        });
      }

      const seedStarted = performance.now();
      for (let session = 0; session < sessions; session += 1) {
        const sessionId = `session-${session}`;
        await ctx.store.createSession({
          sessionId,
          worktree: `/spike/${sessionId}`,
          model: 'spike-model',
          name: `Benchmark chat ${session}`,
          projectId: `project-${session % projectCount}`,
        });

        const events: Array<{ session_id: string; type: string; payload: string }> = [];
        for (let exchange = 0; exchange < exchangesPerSession; exchange += 1) {
          const unique = `needleS${session}E${exchange}`;
          const seed = session * exchangesPerSession + exchange;
          const response = realisticText(seed + 3, unique, 'agent');
          const split = Math.floor(response.length / 2);
          events.push(
            {
              session_id: sessionId,
              type: 'prompt',
              payload: JSON.stringify({
                t: 'prompt',
                text: realisticText(seed, unique, 'user'),
              }),
            },
            {
              session_id: sessionId,
              type: 'text',
              payload: JSON.stringify({
                t: 'text',
                delta: response.slice(0, split),
              }),
            },
            {
              session_id: sessionId,
              type: 'text',
              payload: JSON.stringify({
                t: 'text',
                delta: response.slice(split),
              }),
            },
            {
              session_id: sessionId,
              type: 'result',
              payload: JSON.stringify({ t: 'result', subtype: 'success' }),
            },
          );
        }
        for (let offset = 0; offset < events.length; offset += 500) {
          await ctx.db
            .insertInto('events')
            .values(events.slice(offset, offset + 500))
            .execute();
        }
      }
      const seedMs = performance.now() - seedStarted;

      const backfillStarted = performance.now();
      ctx.store.scheduleMessageProjection();
      await ctx.store.waitForMessageProjectionIdle();
      const backfillMs = performance.now() - backfillStarted;

      const expectedMessages = sessions * exchangesPerSession * 2;
      const messageCount = await ctx.db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      expect(Number(messageCount.count)).toBe(expectedMessages);

      const exact = await ctx.store.searchMessages({ query: exactNeedle, limit: 20 });
      expect(exact).toHaveLength(2);

      const broadGlobalResults = await ctx.store.searchMessages({ query: 'migration', limit: 50 });
      expect(broadGlobalResults).toHaveLength(Math.min(50, sessions * messagesPerSession));
      const broadChatResults = await ctx.store.searchMessages({
        query: 'migration',
        sessionId: `session-${targetSession}`,
        limit: 50,
      });
      expect(broadChatResults).toHaveLength(Math.min(50, messagesPerSession));
      expect(
        broadChatResults.every((result) => result.sessionId === `session-${targetSession}`),
      ).toBe(true);
      const broadProjectResults = await ctx.store.searchMessages({
        query: 'migration',
        projectId: targetProject,
        limit: 50,
      });
      expect(broadProjectResults).toHaveLength(
        Math.min(50, targetProjectSessions * messagesPerSession),
      );
      expect(broadProjectResults.every((result) => result.projectId === targetProject)).toBe(true);

      const globalExact = await sample(() =>
        ctx.store.searchMessages({ query: exactNeedle, limit: 20 }),
      );
      const globalBroad = await sample(() =>
        ctx.store.searchMessages({ query: 'migration', limit: 50 }),
      );
      const chatBroad = await sample(() =>
        ctx.store.searchMessages({
          query: 'migration',
          sessionId: `session-${targetSession}`,
          limit: 50,
        }),
      );
      const projectBroad = await sample(() =>
        ctx.store.searchMessages({ query: 'migration', projectId: targetProject, limit: 50 }),
      );

      const sizes = await sql<{
        events_bytes: number;
        messages_bytes: number;
        fts_index_bytes: number;
        projection_total_bytes: number;
      }>`select
          pg_table_size('events')::bigint as events_bytes,
          pg_table_size('messages')::bigint as messages_bytes,
          pg_relation_size('messages_search_fts_idx')::bigint as fts_index_bytes,
          (pg_total_relation_size('messages') +
            pg_total_relation_size('message_projection_state'))::bigint as projection_total_bytes`
        .execute(ctx.db)
        .then((result) => result.rows[0]!);

      const result = {
        dataset: {
          sessions,
          exchangesPerSession,
          events: sessions * exchangesPerSession * 4,
          messages: expectedMessages,
        },
        timings: {
          seedMs: Number(seedMs.toFixed(2)),
          coldBackfillMs: Number(backfillMs.toFixed(2)),
          globalExact,
          globalBroad,
          chatBroad,
          projectBroad,
        },
        storage: {
          eventsBytes: Number(sizes.events_bytes),
          messagesBytes: Number(sizes.messages_bytes),
          ftsIndexBytes: Number(sizes.fts_index_bytes),
          projectionTotalBytes: Number(sizes.projection_total_bytes),
          projectedBytesPerMessage: Number(
            (Number(sizes.projection_total_bytes) / expectedMessages).toFixed(2),
          ),
        },
      };
      console.log(`SEARCH_PERFORMANCE_SPIKE_RESULT=${JSON.stringify(result)}`);
      expect(result.timings.coldBackfillMs).toBeLessThan(120_000);
      expect(result.timings.globalExact.p95Ms).toBeLessThan(500);
      expect(result.timings.globalBroad.p95Ms).toBeLessThan(1_000);
      expect(result.timings.chatBroad.p95Ms).toBeLessThan(500);
      expect(result.timings.projectBroad.p95Ms).toBeLessThan(750);
      // PostgreSQL relations allocate whole pages, so per-row storage is meaningful
      // only above a minimum population; tiny smoke datasets otherwise measure page overhead.
      if (expectedMessages >= 1_000) {
        expect(result.storage.projectedBytesPerMessage).toBeLessThan(3_584);
      }
    },
    10 * 60_000,
  );
});
