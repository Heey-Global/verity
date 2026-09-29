import { describe, expect, it, vi } from 'vitest';
import { createLiveMeetingAnalysisQuery } from './live-meeting-analysis-query.js';

const sse = (...events: object[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
function setup(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  const query = createLiveMeetingAnalysisQuery({
    fetch,
    codexCredential: async () => ({ accessToken: 'test-access', accountId: 'test-account' }),
    codexDefaultModel: async () => 'codex/concrete',
    openCode: async () => ({ baseUrl: 'https://provider.example/v1/', apiKey: 'test-key' }),
  });
  return { fetch, query };
}

describe('live meeting analysis query', () => {
  it('sends only text and no tools to OpenCode', async () => {
    const ctx = setup(
      Response.json({ choices: [{ finish_reason: 'stop', message: { content: '  insight  ' } }] }),
    );
    expect(await ctx.query({ model: 'verity/provider/model', prompt: 'Private transcript' })).toBe(
      'insight',
    );
    const [url, init] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe('https://provider.example/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer test-key' },
    });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: 'provider/model',
      messages: [{ role: 'user', content: 'Private transcript' }],
      tools: [],
      tool_choice: 'none',
    });
  });

  it('uses a concrete Codex model and requires a completed tool-free response', async () => {
    const ctx = setup(
      new Response(
        sse(
          { type: 'response.output_text.done', text: 'Insight' },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    );
    expect(await ctx.query({ model: 'codex/default', prompt: 'Private transcript' })).toBe(
      'Insight',
    );
    const [url, init] = ctx.fetch.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: 'concrete',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Private transcript' }] }],
      tools: [],
      tool_choice: 'none',
      store: false,
    });
  });

  it('rejects non-text completions and omits upstream error bodies', async () => {
    await expect(
      setup(
        Response.json({
          choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{}] } }],
        }),
      ).query({ model: 'verity/model', prompt: 'text' }),
    ).rejects.toThrow('did not finish with text');
    await expect(
      setup(new Response('private transcript', { status: 500 })).query({
        model: 'verity/model',
        prompt: 'text',
      }),
    ).rejects.toThrow('HTTP 500');
  });

  it('rejects an oversized response', async () => {
    const ctx = setup(new Response('x'.repeat(1_000_001)));
    await expect(ctx.query({ model: 'verity/model', prompt: 'text' })).rejects.toThrow(
      'size limit',
    );
  });
});
