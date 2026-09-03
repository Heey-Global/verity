import { InMemoryEventBus, type Conductor } from '@verity/session';
import { createTestDb, type TestDb } from '@verity/store/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import {
  MAX_MEETING_AUDIO_BASE64_LEN,
  registerMeetingTranscriptRoutes,
  type MeetingTranscriptCreated,
  type MeetingTranscriptRouteDeps,
} from './meeting-transcript-routes.js';
import { buildServer } from './server.js';

let app: FastifyInstance;
const save = vi.fn<MeetingTranscriptRouteDeps['save']>(
  async (): Promise<MeetingTranscriptCreated> => ({
    path: 'meetings/2026-09-03.md',
    title: 'Team Sync',
    segments: 3,
  }),
);
const stream = vi.fn<MeetingTranscriptRouteDeps['stream']>(
  async () => ({ accepted: true }) as const,
);
const STREAM_HEADERS = {
  'content-type': 'application/octet-stream',
  'x-verity-meeting-media-type': 'audio%2Fmp4',
};

describe('Meeting transcript routes', () => {
  beforeEach(() => {
    save.mockClear();
    stream.mockClear();
    app = Fastify();
    // Reproduces what buildServer's error handler does with a ZodError, so the
    // statuses below read like the product's. That it agrees with the product is
    // asserted separately, against a real server, at the bottom of this file.
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid request' });
      return reply.send(error);
    });
    // buildServer hands the streamed route the raw request stream rather than a
    // buffered body; without an equivalent parser Fastify answers 415 before the
    // handler runs and the metadata assertions would never be reached.
    app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload);
    });
    registerMeetingTranscriptRoutes(app, { save, stream });
  });
  afterEach(async () => app.close());

  it('answers an undecodable metadata header with 400 instead of crashing the upload', async () => {
    // A lone '%' is a header a client can produce by concatenating instead of
    // encoding. If the URIError guard is ever dropped, decodeURIComponent throws
    // out of the handler, Fastify reports 500, and the mobile client treats a
    // permanently malformed request as a transient server fault and retries the
    // whole recording — forever, and with the body already streamed.
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts/stream',
      headers: { ...STREAM_HEADERS, 'x-verity-meeting-file-name': 'recording-%.m4a' },
      payload: Buffer.from('audio'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid meeting metadata encoding' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('hands the decoded metadata to the streaming handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts/stream',
      headers: {
        ...STREAM_HEADERS,
        'x-verity-meeting-file-name': 'Team%20Sync%20%E2%9C%93.m4a',
        'x-verity-meeting-title': 'Team%20Sync',
        // Not percent-encoded by the client: an enum, and decoding it would be
        // the one place a stray '%' in a fixed vocabulary could 400 a good request.
        'x-verity-meeting-announce': 'true',
      },
      payload: Buffer.from('audio'),
    });

    // Not a status assertion: the acknowledgement code is set by the handler in
    // buildServer (202), and the stub here sets none. What this route owns is
    // that the handler ran and its result was returned unaltered.
    expect(res.json()).toEqual({ accepted: true });
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]?.[2]).toBe('s1');
    expect(stream.mock.calls[0]?.[3]).toEqual({
      fileName: 'Team Sync ✓.m4a',
      mediaType: 'audio/mp4',
      title: 'Team Sync',
      announceRequest: 'true',
    });
  });

  it('caps the client request id on the decoded value, not on the header it arrived in', async () => {
    // The header tolerates 1200 chars only because encodeURIComponent can expand
    // one code point to 12 ASCII bytes. Collapse the two limits into one and the
    // failure is silent in either direction: cap the header at 100 and a legal
    // non-ASCII id is rejected as too long, honour 1200 on the decoded value and
    // an id twelve times the documented limit reaches the job store as a key.
    const encodedTick = encodeURIComponent('✓'.repeat(100));
    expect(encodedTick.length).toBeGreaterThan(100);
    const accepted = await app.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts/stream',
      headers: {
        ...STREAM_HEADERS,
        'x-verity-meeting-file-name': 'a.m4a',
        'x-verity-meeting-client-request-id': encodedTick,
      },
      payload: Buffer.from('audio'),
    });
    expect(accepted.json()).toEqual({ accepted: true });
    expect(stream.mock.calls[0]?.[3].clientRequestId).toBe('✓'.repeat(100));

    const tooLong = await app.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts/stream',
      headers: {
        ...STREAM_HEADERS,
        'x-verity-meeting-file-name': 'a.m4a',
        // Well inside the header's 1200, three times over the decoded cap.
        'x-verity-meeting-client-request-id': '%20'.repeat(300),
      },
      payload: Buffer.from('audio'),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(stream).toHaveBeenCalledOnce();
  });

  it('rejects a session id outside the identifier alphabet before reaching the handler', async () => {
    // The id is interpolated into transcript paths downstream. A looser copy of
    // this schema — the kind that appears when a route module clones its params
    // instead of tightening them — would let a traversal-shaped id through with
    // every test still green, because nothing else on this path re-validates it.
    for (const url of [
      '/sessions/..%2Fescape/meetings/transcripts',
      '/sessions/has%20space/meetings/transcripts',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url,
        payload: { fileName: 'a.m4a', data: 'AAAA' },
      });
      expect(res.statusCode, url).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('applies the upload schema before the handler sees the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts',
      payload: { fileName: 'a.m4a', data: 'AAAA', title: 'Standup' },
    });

    expect(res.statusCode).toBe(200);
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[2]).toBe('s1');
    expect(save.mock.calls[0]?.[3]).toEqual({
      fileName: 'a.m4a',
      // Defaulted by the schema, not by the handler: a caller that omits it must
      // still reach the transcoder with a concrete media type.
      mediaType: 'audio/mpeg',
      data: 'AAAA',
      title: 'Standup',
    });
  });
});

describe('Meeting transcript routes on a real server', () => {
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

  it('keeps the body limit above the cap the upload schema enforces', () => {
    // The cap lives in this module, the limit is computed in buildServer, and
    // nothing but arithmetic connects them. Raise the cap alone and every test
    // still passes while a legal recording dies as a bare 413 during upload —
    // no field error, no route, and the client has already sent the bytes.
    expect(server.initialConfig.bodyLimit).toBeGreaterThan(MAX_MEETING_AUDIO_BASE64_LEN);
  });

  it('answers an undecodable metadata header with the product 400, not a 500', async () => {
    // The unit tests above install their own ZodError handler. This one runs the
    // route inside buildServer's, which is the status the mobile client actually
    // sees — and the difference between "stop, this request is malformed" and a
    // 500 it will retry with the whole recording attached.
    const res = await server.inject({
      method: 'POST',
      url: '/sessions/s1/meetings/transcripts/stream',
      headers: {
        'content-type': 'application/octet-stream',
        'x-verity-meeting-file-name': 'recording-%.m4a',
        'x-verity-meeting-media-type': 'audio%2Fmp4',
      },
      payload: Buffer.from('audio'),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid meeting metadata encoding' });
  });

  it('answers a rejected session id with the product 400, not a 500', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/sessions/has%20space/meetings/transcripts',
      payload: { fileName: 'a.m4a', data: 'AAAA' },
    });

    expect(res.statusCode).toBe(400);
  });
});
