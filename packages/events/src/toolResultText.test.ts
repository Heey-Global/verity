import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_TEXT_EXTERNALIZE_THRESHOLD,
  TOOL_TEXT_PREVIEW_BUDGET,
  externalizeToolResultText,
  toolResultTextLength,
} from './toolResultText.js';

const big = (n: number) => 'x'.repeat(n);
const textBlock = (text: string) => ({ type: 'text', text });
const imageRef = (id: string) => ({
  type: 'image',
  source: { type: 'verity_ref', media_type: 'image/png', id },
});

describe('toolResultTextLength', () => {
  it('measures a string, a content-block array, and returns 0 for other shapes', () => {
    expect(toolResultTextLength('hello')).toBe(5);
    expect(toolResultTextLength([textBlock('ab'), imageRef('x'), textBlock('cde')])).toBe(5);
    expect(toolResultTextLength({ ok: true })).toBe(0);
    expect(toolResultTextLength(null)).toBe(0);
  });
});

describe('externalizeToolResultText', () => {
  it('leaves small outputs inline with no ref', async () => {
    const store = vi.fn(async () => 'nope');
    const result = await externalizeToolResultText('short output', store);
    expect(result.output).toBe('short output');
    expect(result.ref).toBeUndefined();
    expect(store).not.toHaveBeenCalled();
  });

  it('externalizes a large string: stores full body, keeps a truncated preview', async () => {
    const full = big(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 100);
    const store = vi.fn(async (jsonText: string) => `hash-${String(jsonText.length)}`);
    const result = await externalizeToolResultText(full, store);

    expect(result.ref).toBeDefined();
    expect(result.ref?.bytes).toBe(JSON.stringify(full).length);
    expect(store).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledWith(JSON.stringify(full));
    // Inline output is truncated to the preview budget.
    expect(typeof result.output).toBe('string');
    expect((result.output as string).length).toBe(TOOL_TEXT_PREVIEW_BUDGET);
  });

  it('externalizes a large content-block array but PRESERVES non-text (image) blocks', async () => {
    const output = [textBlock(big(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 50)), imageRef('cafe')];
    const store = vi.fn(async () => 'hash');
    const result = await externalizeToolResultText(output, store);

    expect(result.ref).toBeDefined();
    const blocks = result.output as Array<Record<string, unknown>>;
    // Text block truncated…
    expect((blocks[0] as { text: string }).text.length).toBe(TOOL_TEXT_PREVIEW_BUDGET);
    // …image ref block untouched, so the card still renders it.
    expect(blocks[1]).toEqual(imageRef('cafe'));
  });

  it('spends the preview budget across text blocks and blanks later text', async () => {
    const output = [
      textBlock(big(TOOL_TEXT_PREVIEW_BUDGET - 1)),
      textBlock('abc'),
      imageRef('kept'),
      textBlock('after-budget'),
      textBlock(big(TOOL_TEXT_EXTERNALIZE_THRESHOLD)),
    ];
    const store = vi.fn(async () => 'hash');
    const result = await externalizeToolResultText(output, store);

    const blocks = result.output as Array<{ text?: string }>;
    expect(blocks[0]?.text?.length).toBe(TOOL_TEXT_PREVIEW_BUDGET - 1);
    expect(blocks[1]?.text).toBe('a');
    expect(blocks[2]).toEqual(imageRef('kept'));
    expect(blocks[3]?.text).toBe('');
    expect(blocks[4]?.text).toBe('');
  });

  it('records UTF-8 byte length for non-ASCII stored output', async () => {
    const full = `é€😀${big(TOOL_TEXT_EXTERNALIZE_THRESHOLD)}`;
    const store = vi.fn(async () => 'hash');
    const result = await externalizeToolResultText(full, store);

    // JSON quotes add two bytes; the prefix is 2 + 3 + 4 bytes in UTF-8.
    expect(result.ref?.bytes).toBe(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 11);
  });

  it('does not mutate the input', async () => {
    const full = big(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 10);
    const output = [textBlock(full)];
    const before = JSON.parse(JSON.stringify(output));
    await externalizeToolResultText(output, async () => 'hash');
    expect(output).toEqual(before);
  });

  it('replaces cyclic and BigInt output with a serializable fallback', async () => {
    const cyclic: { text: string; self?: unknown } = {
      text: big(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 1),
    };
    cyclic.self = cyclic;
    const store = vi.fn(async () => 'hash');
    expect((await externalizeToolResultText([cyclic], store)).output).toBe(
      '[non-serializable tool output omitted]',
    );
    expect(
      (
        await externalizeToolResultText(
          [{ text: big(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 1), value: 1n }],
          store,
        )
      ).output,
    ).toBe('[non-serializable tool output omitted]');
    expect(store).not.toHaveBeenCalled();
  });

  it('counts lone UTF-16 surrogates as replacement characters', async () => {
    const full = `\ud800${big(TOOL_TEXT_EXTERNALIZE_THRESHOLD)}`;
    const result = await externalizeToolResultText(full, async () => 'hash');
    // JSON.stringify escapes the lone surrogate as six ASCII characters.
    expect(result.ref?.bytes).toBe(TOOL_TEXT_EXTERNALIZE_THRESHOLD + 8);
  });
});
