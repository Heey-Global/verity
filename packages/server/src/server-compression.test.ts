import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { app, ctx } from './server-fixture.test-helper.js';

// The routes opt into compression with a `compress` route option, which only
// takes effect when the compression plugin's onRoute hook exists before the
// route is declared. Registered the deferred way, the plugin ran after
// `buildServer` had declared every route: each option was ignored, and the
// routes answered in full and uncompressed while every response stayed correct.
// A test app that awaits the plugin cannot see that, so this one asks the
// server `buildServer` assembles.
it('compresses an opted-in read of the assembled server', async () => {
  for (let index = 0; index < 12; index += 1) {
    await ctx.store.upsertProject({
      id: `p-compressed-${index}`,
      owner: 'northwind',
      repo: `shop-${index}`,
      containerName: `verity-northwind--shop-${index}`,
      state: 'absent',
      overviewVisible: true,
    });
  }
  const plain = await app.inject({ method: 'GET', url: '/projects' });
  expect(plain.statusCode).toBe(200);
  expect(plain.rawPayload.length).toBeGreaterThan(1024);

  const zipped = await app.inject({
    method: 'GET',
    url: '/projects',
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  });
  expect(zipped.statusCode).toBe(200);
  expect(zipped.headers['content-encoding']).toBe('gzip');
  expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length);
  expect(JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8'))).toEqual(plain.json());

  // Not opted in: compression stays a per-route choice, never a global one.
  const picker = await app.inject({
    method: 'GET',
    url: '/github/repositories',
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  });
  expect(picker.statusCode).toBe(200);
  expect(picker.rawPayload.length).toBeGreaterThan(1024);
  expect(picker.headers['content-encoding']).toBeUndefined();
});
