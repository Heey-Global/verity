/**
 * Make a serialized event payload storable in PostgreSQL by removing U+0000.
 *
 * PostgreSQL cannot represent NUL in `text` or `jsonb` — not as an encoding
 * quirk but by definition, since its string type is NUL-terminated. Handing
 * `jsonb` a document containing the `\u0000` escape fails the INSERT with
 * SQLSTATE 22P05 (`unsupported Unicode escape sequence`, detail `\u0000 cannot
 * be converted to text`).
 *
 * Agent output reaches `events.payload` verbatim, so one NUL anywhere in it —
 * a hexdump, a `grep -a` over a binary, an edit writing a NUL-separated key —
 * aborted the whole turn with an unrecoverable `run_failed` and no way for the
 * session to move past it: every retry re-read the same bytes and died again.
 * A control character no operator can see is not worth a lost turn, so the
 * persisted copy substitutes the standard marker for an unrepresentable
 * character instead of failing.
 *
 * Like {@link redactSecrets} this rewrites the SERIALIZED payload rather than
 * walking the event object: it is one pass over a string that is already built,
 * and both transformations then share the same "the stored copy differs from
 * the broadcast copy" seam. The live broadcast keeps the original bytes.
 */

/** What a NUL becomes in the persisted copy: U+FFFD REPLACEMENT CHARACTER, the
 *  Unicode-sanctioned stand-in for a character that cannot be represented. Kept
 *  as its JSON escape so the payload stays ASCII. */
const NUL_MARKER = '\\ufffd';

/** Runs of backslashes followed by `u0000`. The run's length decides whether
 *  this is an escape at all — see {@link scrubNulEscapes}. */
const NUL_ESCAPE_RUN = /(\\+)u0000/g;

/**
 * Replace every U+0000 in a JSON-serialized `payload` with {@link NUL_MARKER},
 * returning valid JSON (and the input unchanged when it holds no NUL).
 *
 * `JSON.stringify` emits U+0000 as the six characters `\u0000`, so the scrub
 * works on that escape — but the same six characters also appear when the text
 * legitimately CONTAINS a backslash-u-0000 sequence, e.g. TypeScript source
 * spelling the escape itself. Serialization distinguishes the two by doubling a
 * literal backslash, so the preceding backslash run's parity is the signal: odd
 * means the final backslash opens a real escape, even means every backslash is
 * literal text and the `u0000` after them is ordinary content to be preserved.
 */
export function scrubNulEscapes(payload: string): string {
  return payload.replace(NUL_ESCAPE_RUN, (match, backslashes: string) =>
    backslashes.length % 2 === 1 ? `${backslashes.slice(0, -1)}${NUL_MARKER}` : match,
  );
}
