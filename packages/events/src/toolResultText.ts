import type { ToolResultRef } from './events.js';

/**
 * Content-addressing for LARGE TEXT tool results (sibling of {@link ./toolImages}).
 * A tool can return a lot of text — a `Read` of a big file, long `Bash`/`Grep`
 * output, a big diff. Inlining all of it on the persisted `tool_result` event
 * means opening a session transfers and JSON-parses the whole backlog up front,
 * even though the card only ever shows a ~120-char preview.
 *
 * So the store externalizes the full output into the content-addressed blob table
 * at append time and keeps only a short truncated preview inline, plus an
 * {@link ToolResultRef} (`outputRef` on the event) pointing at the full body. The
 * preview is enough for display; the full body stays available (for a future
 * cross-backend context handoff, and a "show full output" affordance) and loads
 * only on demand — never up front.
 *
 * The full body is stored as the JSON serialization of the (image-externalized)
 * output, so it round-trips any output shape. Only string and content-block-array
 * outputs are externalized; other shapes are left inline (they aren't the large
 * case). Live-streamed events keep their full inline text (the client already has
 * it); only the persisted copy is truncated.
 */

/** Text size (in chars) above which a tool result's output is externalized. */
export const TOOL_TEXT_EXTERNALIZE_THRESHOLD = 4096;

/** How much text to keep inline as the display preview when externalizing. Far
 * more than the card shows (~120 chars, first line), but tiny vs. a big body. */
export const TOOL_TEXT_PREVIEW_BUDGET = 1024;

function isTextBlock(block: unknown): block is { text: string } & Record<string, unknown> {
  return (
    !!block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
  );
}

/**
 * Total text length of a tool_result `output`: the string itself, or the sum of
 * `text` across a content-block array. Other shapes return 0 (not externalized).
 */
export function toolResultTextLength(output: unknown): number {
  if (typeof output === 'string') return output.length;
  if (Array.isArray(output)) {
    let total = 0;
    for (const block of output) if (isTextBlock(block)) total += block.text.length;
    return total;
  }
  return 0;
}

/** A truncated copy for inline display: caps text to {@link TOOL_TEXT_PREVIEW_BUDGET}
 * while PRESERVING every non-text block (e.g. externalized image refs) so the card
 * still renders them. The input is never mutated. */
function truncateOutput(output: unknown): unknown {
  if (typeof output === 'string') return output.slice(0, TOOL_TEXT_PREVIEW_BUDGET);
  if (Array.isArray(output)) {
    const blocks = output as unknown[];
    let budget = TOOL_TEXT_PREVIEW_BUDGET;
    return blocks.map((block): unknown => {
      if (!isTextBlock(block)) return block;
      if (budget <= 0) return { ...block, text: '' };
      const text = block.text;
      if (text.length <= budget) {
        budget -= text.length;
        return block;
      }
      const kept = text.slice(0, budget);
      budget = 0;
      return { ...block, text: kept };
    });
  }
  return output;
}

/**
 * Externalize a large tool_result `output`: store the full body via
 * `store(jsonText) => id` and return a truncated inline copy plus the ref. A small
 * output (or a non-string/array shape, or a non-serializable one) passes through
 * unchanged with no ref, so it is safe and idempotent to run on every append. The
 * input is never mutated — a caller can still broadcast the original inline event.
 */
export async function externalizeToolResultText(
  output: unknown,
  store: (jsonText: string) => Promise<string>,
): Promise<{ output: unknown; ref?: ToolResultRef }> {
  if (toolResultTextLength(output) <= TOOL_TEXT_EXTERNALIZE_THRESHOLD) return { output };
  const jsonText = JSON.stringify(output);
  if (jsonText === undefined) return { output }; // non-serializable — leave inline
  const id = await store(jsonText);
  return { output: truncateOutput(output), ref: { id, bytes: utf8ByteLength(jsonText) } };
}

/** UTF-8 byte length of a string, without relying on `TextEncoder`/`Buffer` (this
 * module is shared by the RN app and the Node server). */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // a surrogate pair encodes one 4-byte code point
      i++;
    } else bytes += 3;
  }
  return bytes;
}
