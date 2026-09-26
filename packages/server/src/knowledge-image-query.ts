import { z } from 'zod';

import type { CodexUsageCredentialProvider } from './codexUsage.js';
import type { ImageTextExtractorDeps } from './knowledge-image-text.js';

type Query = ImageTextExtractorDeps['query'];
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

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid image model JSON response');
  }
}

/** Bounded even when the upstream omits Content-Length or streams indefinitely. */
async function responseText(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Image model request failed (HTTP ${String(response.status)})`);
  }
  if (!response.body) throw new Error('Image model response is empty');
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Image model response exceeds size limit');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** No agent, tool dispatcher, project files, or refresh tokens enter this path. */
export function createKnowledgeImageQuery(deps: {
  fallback: Query;
  codexCredential?: CodexUsageCredentialProvider | undefined;
  codexDefaultModel: () => Promise<string | undefined>;
  openCode: () => Promise<{ baseUrl: string; apiKey: string } | undefined>;
  fetch?: typeof fetch;
}): Query {
  const request = deps.fetch ?? fetch;
  return async (input) => {
    const model = input.model;
    const codex = model?.startsWith('codex/') === true;
    const openCode = model?.startsWith('verity/') === true;
    if (!codex && !openCode) return deps.fallback(input);
    const images = (input.attachments ?? []).filter((item) => item.kind === 'image');
    if (images.length === 0) throw new Error('Image model request has no image');
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(input.signal === undefined ? [] : [input.signal]),
    ]);
    let url: string;
    let headers: Record<string, string>;
    let body: object;
    if (codex) {
      const selected = model === 'codex/default' ? await deps.codexDefaultModel() : model;
      const id = selected?.startsWith('codex/') ? selected.slice('codex/'.length) : undefined;
      if (!id || id === 'default') throw new Error('No concrete Codex default model available');
      const credential = await deps.codexCredential?.();
      if (!credential) throw new Error('Codex image model login unavailable');
      url = 'https://chatgpt.com/backend-api/codex/responses';
      headers = {
        authorization: `Bearer ${credential.accessToken}`,
        'chatgpt-account-id': credential.accountId,
      };
      body = {
        model: id,
        instructions: input.prompt,
        input: [
          {
            role: 'user',
            content: images.map((image) => ({
              type: 'input_image',
              image_url: `data:${image.mediaType};base64,${image.data}`,
            })),
          },
        ],
        tools: [],
        tool_choice: 'none',
        store: false,
        stream: true,
      };
    } else {
      const settings = await deps.openCode();
      if (!settings) throw new Error('OpenCode image model configuration unavailable');
      const base = new URL(settings.baseUrl);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
        throw new Error('OpenCode image model URL is invalid');
      url = `${base.href.replace(/\/$/u, '')}/chat/completions`;
      headers = { authorization: `Bearer ${settings.apiKey}` };
      body = {
        model: model.slice('verity/'.length),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: input.prompt },
              ...images.map((image) => ({
                type: 'image_url',
                image_url: {
                  url: `data:${image.mediaType};base64,${image.data}`,
                },
              })),
            ],
          },
        ],
        tools: [],
        tool_choice: 'none',
        max_tokens: 8192,
        stream: false,
      };
    }
    // Never log upstream error bodies: they can echo credentials or image content.
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
      if (!parsed.success) throw new Error('Invalid image model response');
      const choice = parsed.data.choices[0]!;
      if (
        choice.finish_reason !== 'stop' ||
        choice.message.tool_calls?.length ||
        choice.message.function_call != null
      )
        throw new Error('Image model response did not finish with text');
      return choice.message.content.trim() || undefined;
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
      if (!parsed.success) throw new Error('Invalid Codex image response');
      const event = parsed.data;
      if (event.item && event.item.type !== 'message' && event.item.type !== 'reasoning')
        throw new Error('Codex image response unexpectedly requested a tool');
      if (
        event.type === 'error' ||
        event.type === 'response.failed' ||
        event.type === 'response.incomplete'
      )
        throw new Error('Codex image response failed');
      if (event.type === 'response.output_text.done' && event.text !== undefined)
        texts.push(event.text);
      if (event.type === 'response.completed') complete = event.response?.status === 'completed';
    }
    if (!complete) throw new Error('Codex image response did not complete');
    return texts.join('\n').trim() || undefined;
  };
}
