/**
 * Content-addressing for images returned INSIDE a tool result (e.g. a `Read` of a
 * PNG, a screenshot — issue #115). Distinct from operator prompt attachments
 * (see {@link ./events.attachmentSchema}), but solving the same problem: `claude`
 * returns an image tool result as a content-block array
 * `[{ type:'image', source:{ type:'base64', media_type, data } }]`, and inlining
 * that base64 on the persisted `tool_result` event bloats every session open —
 * the whole image backlog transfers and parses up front even for off-screen rows.
 *
 * The store externalizes those bytes into the content-addressed `attachments`
 * table at append time and rewrites each block's `source` to the ref form below;
 * the client then fetches the image lazily by id (`GET /attachments/:id`), exactly
 * like a prompt attachment. Live-streamed events keep their inline base64 (the
 * client already has the bytes → renders instantly, no round-trip); only the
 * persisted copy — the one a reload replays — is externalized.
 *
 * Both the writer (store) and the reader (mobile card) import from here so the
 * on-disk shape stays defined in exactly one place.
 */

/** `source.type` of an externalized (content-addressed) tool-result image block.
 * The legacy inline form uses `'base64'` with `source.data`. */
export const TOOL_IMAGE_REF_TYPE = 'verity_ref';

/** One image lifted off a tool result. Exactly one of `id`/`data` is set: `id`
 * for an externalized ref (lazy-fetched via `GET /attachments/:id`), `data` for a
 * legacy inline block (raw base64, no `data:` prefix). */
export interface ToolResultImage {
  mediaType: string;
  id?: string;
  data?: string;
}

/** Narrow an unknown block to `{ source: {...} }` if it's an image content block. */
function imageSource(block: unknown): Record<string, unknown> | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  if (b.type !== 'image' || !b.source || typeof b.source !== 'object') return null;
  return b.source as Record<string, unknown>;
}

/**
 * Lift every image out of a tool_result `output`, in document order. Handles both
 * the legacy inline-base64 form (`source.type === 'base64'`, `source.data`) and the
 * externalized ref form (`source.type === TOOL_IMAGE_REF_TYPE`, `source.id`).
 * Anything not matching an image content-block array yields no images, so a plain
 * text/JSON result is unaffected.
 */
export function extractToolResultImages(output: unknown): ToolResultImage[] {
  if (!Array.isArray(output)) return [];
  const images: ToolResultImage[] = [];
  for (const block of output) {
    const source = imageSource(block);
    if (!source || typeof source.media_type !== 'string') continue;
    if (
      source.type === TOOL_IMAGE_REF_TYPE &&
      typeof source.id === 'string' &&
      source.id.length > 0
    ) {
      images.push({ mediaType: source.media_type, id: source.id });
    } else if (
      source.type === 'base64' &&
      typeof source.data === 'string' &&
      source.data.length > 0
    ) {
      images.push({ mediaType: source.media_type, data: source.data });
    }
  }
  return images;
}

/**
 * Rewrite a tool_result `output`, replacing each INLINE-base64 image block's source
 * with a content-addressed ref via `store(mediaType, base64) => id`. Returns a new
 * output (only the changed blocks are cloned — the input is never mutated, so a
 * caller can still broadcast the original inline event) and whether anything
 * changed. Blocks already in ref form, non-image blocks, and non-array outputs pass
 * through untouched (`changed: false`), so it is safe and idempotent to run on
 * every `tool_result` append.
 */
export async function externalizeToolResultImages(
  output: unknown,
  store: (mediaType: string, base64Data: string) => Promise<string>,
): Promise<{ output: unknown; changed: boolean }> {
  if (!Array.isArray(output)) return { output, changed: false };
  const blocks = output as unknown[];
  let changed = false;
  const next = await Promise.all(
    blocks.map(async (block): Promise<unknown> => {
      const source = imageSource(block);
      if (
        !source ||
        source.type !== 'base64' ||
        typeof source.media_type !== 'string' ||
        typeof source.data !== 'string' ||
        source.data.length === 0
      ) {
        return block;
      }
      const id = await store(source.media_type, source.data);
      changed = true;
      const nextSource: Record<string, unknown> = { ...source, type: TOOL_IMAGE_REF_TYPE, id };
      delete nextSource.data;
      return { ...(block as Record<string, unknown>), source: nextSource };
    }),
  );
  return changed ? { output: next, changed } : { output, changed: false };
}
