import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, type TestDb } from '@verity/store/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_MEETING_AUDIO_BASE64_LEN } from './meeting-transcript-routes.js';
import { buildServer } from './server.js';
import { TURN_BODY_LIMIT_BYTES } from './session-turn-route.js';

/** A body comfortably larger than Fastify's own 1 MiB default, standing in for
 *  the text-bearing JSON the un-opted-out routes accept. */
const ORDINARY_JSON_BODY_BYTES = 1_500_000;

/** Comfortably past the default, so a request carrying it reaches its handler
 *  only on a route that opted out of the default one way or another. */
const OVER_DEFAULT_BODY_BYTES = 3_000_000;

/**
 * The policy `buildServer`'s default body limit implements: bulk is declared by
 * the routes that need it, never granted to all of them at once.
 *
 * It used to be the other way round — the default was sized from the largest
 * upload cap, so every route in the server would buffer ~71 MB. A buffered
 * base64 body costs about three times its own size while the body, the string
 * `JSON.parse` produces from it and the decoded Buffer all exist, and V8 does
 * not hand that peak back to the OS afterwards.
 */
describe('default body limit', () => {
  let ctx: TestDb;
  let server: FastifyInstance;

  beforeAll(async () => {
    ctx = await createTestDb();
    server = buildServer({
      eventStore: ctx.store,
      bus: new InMemoryEventBus(),
      conductor: {} as Conductor,
    });
    await server.ready();
  });
  afterAll(async () => {
    await server?.close();
    await ctx.close();
  });

  it('stays below what the upload routes declare for themselves', () => {
    // What keeps the per-route limits load-bearing. Raise the default to cover an
    // upload route — the tempting fix the next time one 413s — and deleting that
    // route's own `bodyLimit` stops failing anything, because the default now
    // covers it. Nothing is red, and the ceiling is back on every route at once.
    expect(server.initialConfig.bodyLimit).toBeLessThan(MAX_MEETING_AUDIO_BASE64_LEN);
    expect(server.initialConfig.bodyLimit).toBeLessThan(TURN_BODY_LIMIT_BYTES);
  });

  it('still clears the JSON an ordinary route receives', () => {
    // The cost side of the same decision, and the reason this is not simply set
    // to Fastify's 1 MiB. `PATCH /sessions/:id` declares no limit of its own, so
    // it is served by the default like almost every route here. Tighten the
    // default far enough and bodies that used to reach their schema start dying
    // as 413s instead — a saving paid for in broken requests.
    expect(server.initialConfig.bodyLimit).toBeGreaterThan(ORDINARY_JSON_BODY_BYTES);
  });

  it('lets the two upload routes buffer past the default on the real server', async () => {
    // The per-route `{ bodyLimit }` is read off the registration elsewhere; this
    // asks the assembled server, which is the only place the two interact. A
    // limit declared on a route that `buildServer` registers through a different
    // instance — a prefixed `register`, an encapsulated plugin — reads back
    // correctly from an `onRoute` probe and still never reaches the request.
    const oversized = 'A'.repeat(OVER_DEFAULT_BODY_BYTES);

    // The oversized prompt travels beside a field the turn schema rejects, so
    // the answer is a deterministic schema 400 rather than whatever this test's
    // stub conductor would do with a dispatch it cannot serve. Either way the
    // 3 MB body was read off the socket and handed to the schema, which is the
    // claim — a 413 never gets that far.
    const turn = await server.inject({
      method: 'POST',
      url: '/sessions/does-not-exist/turns',
      payload: { prompt: oversized, clientReplyId: '' },
    });
    expect(turn.statusCode).toBe(400);

    const meeting = await server.inject({
      method: 'POST',
      url: '/sessions/does-not-exist/meetings/transcripts',
      payload: { fileName: 'a.m4a', data: oversized },
    });
    expect(meeting.statusCode).toBe(404);
  });

  it('keeps the streamed upload route off the buffered path entirely', async () => {
    // `POST /sessions/:id/files` accepts a 250 MB file and declares no body limit
    // at all: its content type is rewritten to `application/octet-stream`, whose
    // parser hands the handler the raw stream, and Fastify enforces no limit on a
    // body it never buffers. That machinery used to be an optimisation — a
    // request that slipped past it still had 71 MB of global allowance to land
    // in. With the default at 2 MB it is load-bearing: drop the rewrite hook or
    // the parser and every upload over 2 MB dies as a 413, with the test suite
    // otherwise green.
    //
    // Sent as `application/json` on purpose. That is a content type Fastify does
    // buffer, so without the rewrite this is a 413 rather than the 415 an
    // unparseable type would give — the failure has to land on the limit.
    const res = await server.inject({
      method: 'POST',
      url: '/sessions/does-not-exist/files?fileName=upload.bin',
      headers: { 'content-type': 'application/json' },
      payload: Buffer.alloc(OVER_DEFAULT_BODY_BYTES, 0x41),
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves a default-limit route a body of that size', async () => {
    // The assertion above reads a number; this one proves the number is the one
    // actually in force on a route that declares nothing. A default applied
    // somewhere other than the Fastify constructor would satisfy the former and
    // fail here.
    const res = await server.inject({
      method: 'PATCH',
      url: '/sessions/does-not-exist',
      payload: { name: 'x'.repeat(ORDINARY_JSON_BODY_BYTES) },
    });
    // The name is far past the schema's 80-character cap and the session does not
    // exist, so this is a 400 or a 404 — the point is only that the body was read
    // at all rather than refused while Fastify was still on the socket.
    expect(res.statusCode).not.toBe(413);
  });
});
