import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, truncateAll, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthTokenRegistry, type AuthTokenRegistry } from './auth.js';
import type { MemoryDiagnostics } from './diagnostics-memory-route.js';
import { buildServer } from './server.js';

describe('GET /diagnostics/memory', () => {
  let ctx: TestDb;
  let app: FastifyInstance;
  let registry: AuthTokenRegistry;

  beforeAll(async () => {
    ctx = await createTestDb();
  });
  afterAll(async () => {
    await app?.close();
    await ctx.close();
  });
  beforeEach(async () => {
    if (app !== undefined) await app.close();
    await truncateAll(ctx.db);
    registry = await createAuthTokenRegistry(ctx.store, { enabled: true });
    app = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
      authRegistry: registry,
    });
  });

  async function sample(token: string): Promise<MemoryDiagnostics> {
    const res = await app.inject({
      method: 'GET',
      url: '/diagnostics/memory',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // Every sample is point-in-time; a cached one is wrong while still looking
    // current, so the header is part of the contract rather than a nicety.
    expect(res.headers['cache-control']).toBe('no-store');
    return res.json<MemoryDiagnostics>();
  }

  it('refuses a caller without the operator bearer', async () => {
    // The silent failure this exists for: the route carries no credential check
    // of its own, and is safe only because it is absent from NON_OPERATOR_ROUTES
    // and the default-deny gate therefore covers it. Declaring it there — the
    // plausible mistake, since every neighbouring route module has an entry —
    // would open it without changing a line of the route itself, and what leaks
    // is how close the process is to its heap limit. Registration ORDER is not
    // what protects it: the gate is an un-encapsulated `app.addHook`, verified by
    // moving the call above it and watching this still return 401.
    const res = await app.inject({ method: 'GET', url: '/diagnostics/memory' });
    expect(res.statusCode).toBe(401);
  });

  it('reports a live sample rather than a stub', async () => {
    const { token } = await registry.mint('iPhone');
    const snapshot = await sample(token);

    // Derived from what the numbers mean to each other, not from values read off
    // a run: every field is pinned by at least one relation that a hardcoded 0
    // violates, while a genuine sample satisfies all of them on any machine.
    // `arrayBuffers` is documented as a subset of `external`, which is what lets
    // the two be checked against each other rather than against a magic number.
    expect(snapshot.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.heapTotalBytes).toBeGreaterThanOrEqual(snapshot.heapUsedBytes);
    expect(snapshot.heapLimitBytes).toBeGreaterThanOrEqual(snapshot.heapTotalBytes);
    expect(snapshot.rssBytes).toBeGreaterThan(0);
    expect(snapshot.externalBytes).toBeGreaterThan(0);
    expect(snapshot.externalBytes).toBeGreaterThanOrEqual(snapshot.arrayBuffersBytes);
    // Fractional, so this does not depend on the process having crossed a whole
    // second before the first sample — only on the clock not being stubbed out.
    expect(snapshot.uptimeSeconds).toBeGreaterThan(0);
  });

  it('counts Buffer memory outside the JS heap', async () => {
    // The reason this route reports six numbers instead of just `rss`. A body
    // buffered by Fastify or a file read whole lands in `external`/`arrayBuffers`
    // and leaves `heapUsed` flat; parsed event payloads do the opposite. Collapse
    // the response to `rss` and `heapUsed` — the obvious simplification — and the
    // route still answers 200 with plausible numbers while having lost the one
    // distinction it was built to draw.
    const { token } = await registry.mint('iPhone');
    const before = await sample(token);

    const HELD_BYTES = 32 * 1024 * 1024;
    const held = Buffer.alloc(HELD_BYTES);
    held[0] = 1; // Keep the allocation observable; an unread buffer may be elided.

    const after = await sample(token);
    // Half the allocation, not most of it: the baseline sample also retains
    // ArrayBuffers from its own inject round-trip, and whether those survive to
    // the second sample is a GC-timing question. A stub reports a delta of 0, so
    // the loose bound still separates the two cases without depending on it.
    expect(after.arrayBuffersBytes - before.arrayBuffersBytes).toBeGreaterThan(HELD_BYTES / 2);
    // Same allocation, and it must NOT show up as JS heap growth — that is the
    // half of the distinction a collapsed response would silently lose.
    expect(after.heapUsedBytes - before.heapUsedBytes).toBeLessThan(HELD_BYTES / 2);
    expect(held.length).toBe(HELD_BYTES); // Hold the reference past the sample.
  });
});
