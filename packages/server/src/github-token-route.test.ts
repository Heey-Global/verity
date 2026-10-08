import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerGitHubTokenRoute } from './github-token-route.js';

it('never returns a token even when a capability is supplied', async () => {
  const app = Fastify();
  registerGitHubTokenRoute(app);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/github/token',
      headers: { authorization: `Bearer ${'c'.repeat(43)}` },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ error: 'Token issuance removed; use the forge proxy' });
  } finally {
    await app.close();
  }
});
