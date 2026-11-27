import { expect, it, vi } from 'vitest';
import { mcpAppsClient } from './mcp-apps-client.js';

it('mints a same-server document URL without putting the device credential in it', async () => {
  const path = `/mcp-app-document?ticket=${'x'.repeat(43)}`;
  const request = vi.fn(async () => Response.json({ path }));
  const client = mcpAppsClient(request, () => 'https://verity.example');
  const controller = new AbortController();
  expect(await client.createMcpAppDocumentUrl('s/a', 'app', controller.signal)).toBe(
    `https://verity.example${path}`,
  );
  expect(request).toHaveBeenCalledWith('/sessions/s%2Fa/mcp-apps/app/document', {
    method: 'POST',
    signal: controller.signal,
  });
  for (const path of ['https://attacker.example', '//attacker.example', '/other?ticket=x']) {
    request.mockResolvedValueOnce(Response.json({ path }));
    await expect(client.createMcpAppDocumentUrl('s', 'a')).rejects.toThrow();
  }
});
