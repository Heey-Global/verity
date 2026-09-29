import { z } from 'zod';

import type { CodexUsageCredentialProvider } from './codexUsage.js';

const MAX_RESPONSE_BYTES = 1_000_000;
const codexEvent = z.object({
  type: z.string(),
  text: z.string().optional(),
  item: z.object({ type: z.string() }).optional(),
  response: z.object({ status: z.string() }).optional(),
});
const completion = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({
          content: z.string(),
          tool_calls: z.array(z.unknown()).nullish(),
          function_call: z.unknown().optional(),
        }),
      }),
    )
    .min(1),
});

async function responseText(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Meeting analysis request failed (HTTP ${String(response.status)})`);
  }
  if (!response.body) throw new Error('Meeting analysis response is empty');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error('Meeting analysis response exceeds size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid meeting analysis JSON response');
  }
}

/** Direct text-only inference. No agent, tools, or project files enter this path. */
export function createLiveMeetingAnalysisQuery(deps: {
  codexCredential?: CodexUsageCredentialProvider | undefined;
  codexDefaultModel: () => Promise<string | undefined>;
  openCode: () => Promise<{ baseUrl: string; apiKey: string } | undefined>;
  fetch?: typeof fetch;
}) {
  const request = deps.fetch ?? fetch;
  return async (input: {
    model: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string> => {
    const codex = input.model.startsWith('codex/');
    const openCode = input.model.startsWith('verity/');
    if (!codex && !openCode) throw new Error('Unsupported meeting analysis model');
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(input.signal === undefined ? [] : [input.signal]),
    ]);
    let url: string;
    let headers: Record<string, string>;
    let body: object;
    if (codex) {
      const selected =
        input.model === 'codex/default' ? await deps.codexDefaultModel() : input.model;
      const id = selected?.startsWith('codex/') ? selected.slice('codex/'.length) : undefined;
      if (!id || id === 'default') throw new Error('No concrete Codex default model available');
      const credential = await deps.codexCredential?.();
      if (!credential) throw new Error('Codex meeting analysis login unavailable');
      url = 'https://chatgpt.com/backend-api/codex/responses';
      headers = {
        authorization: `Bearer ${credential.accessToken}`,
        'chatgpt-account-id': credential.accountId,
      };
      body = {
        model: id,
        instructions:
          'Analyze the provided meeting transcript and return only the requested result.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: true,
      };
    } else {
      const settings = await deps.openCode();
      if (!settings) throw new Error('OpenCode meeting analysis configuration unavailable');
      const base = new URL(settings.baseUrl);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
        throw new Error('OpenCode meeting analysis URL is invalid');
      url = `${base.href.replace(/\/$/u, '')}/chat/completions`;
      headers = { authorization: `Bearer ${settings.apiKey}` };
      body = {
        model: input.model.slice('verity/'.length),
        messages: [{ role: 'user', content: input.prompt }],
        tools: [],
        tool_choice: 'none',
        max_tokens: 2048,
        stream: false,
      };
    }
    // Upstream error bodies may echo credentials or transcript text.
    const response = await request(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });
    const raw = await responseText(response);
    if (!codex) {
      const parsed = completion.safeParse(parseJson(raw));
      if (!parsed.success) throw new Error('Invalid meeting analysis response');
      const choice = parsed.data.choices[0]!;
      if (
        choice.finish_reason !== 'stop' ||
        choice.message.tool_calls?.length ||
        choice.message.function_call != null
      )
        throw new Error('Meeting analysis response did not finish with text');
      return choice.message.content.trim();
    }
    let complete = false;
    const texts: string[] = [];
    for (const frame of raw.split(/\r?\n\r?\n/u)) {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      const parsed = codexEvent.safeParse(parseJson(data));
      if (!parsed.success) throw new Error('Invalid Codex meeting analysis response');
      const event = parsed.data;
      if (event.item && event.item.type !== 'message' && event.item.type !== 'reasoning')
        throw new Error('Codex meeting analysis unexpectedly requested a tool');
      if (
        event.type === 'error' ||
        event.type === 'response.failed' ||
        event.type === 'response.incomplete'
      )
        throw new Error('Codex meeting analysis response failed');
      if (event.type === 'response.output_text.done' && event.text !== undefined)
        texts.push(event.text);
      if (event.type === 'response.completed') complete = event.response?.status === 'completed';
    }
    if (!complete) throw new Error('Codex meeting analysis response did not complete');
    return texts.join('\n').trim();
  };
}
