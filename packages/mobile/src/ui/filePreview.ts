/** Max characters per rendered preview block. React Native lays every `<Text>` out
 *  as a single native text node, so a whole file in one node stops rendering well
 *  before the server's 1 MB text-preview limit — a ~143 KB Markdown file draws an
 *  empty view on iOS. Splitting the body into small blocks keeps each layout pass
 *  cheap and lets the list virtualize them. */
const DEFAULT_MAX_CHUNK_CHARS = 2_000;

/** Point at which a *single* line is split mid-way despite the cost (see below).
 *  Deliberately far above the block budget: no source, Markdown, log or pretty JSON
 *  line comes close, so real files never take a mid-line break, while a minified
 *  bundle or lock file still gets broken up instead of rendering blank. */
const DEFAULT_MAX_LINE_CHARS = 8_000;

/**
 * Split a text file's content into render-sized blocks for the session file preview.
 *
 * Blocks normally break only on line boundaries, so `chunks.join('\n')` reproduces
 * the file exactly for any file whose longest line is under `maxLineChars`.
 *
 * A mid-line break is a real cost, which is why the two budgets differ: each block
 * renders as its own block-level `<Text>`, so splitting a line draws a hard break at
 * a fixed character count rather than at the column the text would naturally wrap
 * to. But leaving a line whole means leaving it in one native text node, which is
 * the exact failure this helper exists to fix. So lines are kept intact up to a
 * budget four times the block budget, and only past that — where the choice is a
 * ragged wrap versus a blank preview — split. Callers that need the exact bytes
 * (copy to clipboard, share) should use the original content, not the chunks.
 *
 * Empty content returns no chunks at all, so the caller can show an explicit
 * "empty file" hint rather than a blank scroll area that looks like a failure.
 */
export function chunkFilePreview(
  content: string,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
  maxLineChars: number = DEFAULT_MAX_LINE_CHARS,
): string[] {
  if (content.length === 0) return [];
  const limit = Math.max(1, Math.floor(maxChunkChars));
  const lineLimit = Math.max(limit, Math.floor(maxLineChars));
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  for (const line of content.split('\n')) {
    let rest = line;
    while (rest.length > lineLimit) {
      flush();
      chunks.push(rest.slice(0, lineLimit));
      rest = rest.slice(lineLimit);
    }
    // +1 for the newline that rejoins this line to the one before it in the block.
    if (current.length > 0 && currentLength + rest.length + 1 > limit) flush();
    currentLength += current.length > 0 ? rest.length + 1 : rest.length;
    current.push(rest);
  }
  flush();
  return chunks;
}
