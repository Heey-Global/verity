import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerSessionTurnRoute, TURN_BODY_LIMIT_BYTES } from './session-turn-route.js';
import { isAttachmentBase64TotalSizeAllowed } from './server.js';

/** Registers the route on a bare instance and reports what it declared. */
async function declaredBodyLimit(): Promise<number | undefined> {
  const app = Fastify();
  let limit: number | undefined;
  app.addHook('onRoute', (route) => {
    if (route.url === '/sessions/:id/turns') limit = route.bodyLimit;
  });
  registerSessionTurnRoute(app, { dispatch: vi.fn(async () => ({ accepted: true })) });
  await app.ready();
  await app.close();
  return limit;
}

describe('POST /sessions/:id/turns body limit', () => {
  it('declares its own limit rather than relying on the server default', async () => {
    // This route and the meeting upload are the only two that may buffer a
    // base64 payload, and the allowance is now theirs alone — buildServer's
    // default is roughly 2 MB. Drop `{ bodyLimit }` from the registration and
    // nothing fails to compile and no other test notices: turns carrying a
    // screenshot just start dying as bare 413s, before the schema that would
    // have named the offending field ever runs.
    expect(await declaredBodyLimit()).toBe(TURN_BODY_LIMIT_BYTES);
  });

  it('clears the largest attachment payload the turn schema accepts', () => {
    // Nothing but arithmetic connects the two: `turnBody` rejects an oversized
    // attachment array with a field error, and this limit decides whether the
    // request survives long enough for that to run. Raise the attachment cap in
    // server.ts alone and every other test still passes while the largest legal
    // turn dies as a bare 413 — the failure mode this pair exists to catch.
    //
    // Asked of the exported predicate rather than restated from the constant it
    // reads, so moving the cap moves this expectation with it.
    let accepted = 0;
    for (let probe = 1 << 30; probe >= 1; probe = Math.floor(probe / 2)) {
      const candidate = accepted + probe;
      if (isAttachmentBase64TotalSizeAllowed([{ base64Length: candidate, paddingCharacters: 0 }])) {
        accepted = candidate;
      }
    }
    // The search found a real boundary rather than bottoming out at zero.
    expect(accepted).toBeGreaterThan(0);
    expect(
      isAttachmentBase64TotalSizeAllowed([{ base64Length: accepted + 1, paddingCharacters: 0 }]),
    ).toBe(false);

    expect(TURN_BODY_LIMIT_BYTES).toBeGreaterThan(accepted);
  });
});
