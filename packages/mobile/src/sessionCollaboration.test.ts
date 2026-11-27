import { describe, expect, it } from 'vitest';
import { VerityClient } from './api.js';

const entry = {
  sessionId: 'peer/1',
  sessionName: 'Auth refactor',
  projectId: 'server',
  projectName: 'Server',
  direction: 'handedOver',
  state: 'working',
  updatedAt: '2026-11-22T12:00:00.000Z',
  section: 'current',
};

function clientReturning(body: unknown) {
  const urls: string[] = [];
  const client = new VerityClient({
    baseUrl: 'http://host',
    fetch: async (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, urls };
}

describe('session collaboration API', () => {
  it('reads the entries of an encoded session id', async () => {
    const { client, urls } = clientReturning({ entries: [entry] });
    expect(await client.sessionCollaboration.read('a/b')).toEqual([entry]);
    expect(urls).toEqual(['http://host/sessions/a%2Fb/collaboration']);
  });

  // A server that grows a new state must fail loudly here rather than render
  // an entry the row has no colour, arrow or spoken word for.
  it.each([
    ['direction', 'forwarded'],
    ['state', 'paused'],
    ['section', 'later'],
  ])('rejects an unknown %s', async (field, value) => {
    const { client } = clientReturning({ entries: [{ ...entry, [field]: value }] });
    await expect(client.sessionCollaboration.read('s')).rejects.toThrow();
  });
});
