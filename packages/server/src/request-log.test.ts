import { expect, it } from 'vitest';
import { serializeServerRequest } from './request-log.js';
import { createMcpAppDocumentTickets } from './mcp-apps-tickets.js';

it('redacts document capabilities and OAuth values even for unsuccessful requests', () => {
  const ticket = createMcpAppDocumentTickets().mint({
    sessionId: 's',
    appId: 'a',
    userId: 'viewer',
    authorized: async () => true,
  });
  for (const method of ['GET', 'POST', 'HEAD']) {
    const serialized = serializeServerRequest({
      method,
      url: `/mcp-app-document?ticket=${ticket}&bad=value`,
    });
    expect(serialized.url).toBe('/mcp-app-document');
    expect(JSON.stringify(serialized)).not.toContain(ticket);
    expect(
      serializeServerRequest({ method, url: '/app/mcp/oauth/callback?code=private' }).url,
    ).toBe('/app/mcp/oauth/callback');
  }
  expect(serializeServerRequest({ method: 'GET', url: '/sessions?limit=10' }).url).toBe(
    '/sessions?limit=10',
  );
});
