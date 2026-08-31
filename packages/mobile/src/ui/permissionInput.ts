import { spellOutBidiControls } from './bidi.js';

/**
 * The best description available of a value `JSON.stringify` refused.
 *
 * `String` is the general answer and the right one for a primitive, but for an object it is
 * `[object Object]` — an Allow button over a string that contains nothing of the request, and
 * one that reads like content rather than like a failure. Naming the top-level fields says at
 * least what is being decided about, and says plainly that the values are not shown.
 *
 * A circular structure and a `BigInt` are the two ways a plain object reaches this, and both
 * leave the keys readable. Neither is producible by `JSON.parse`, so no JSON-RPC-parsed input
 * gets here today; this is what the path prints on the day some other caller does.
 */
function describeUnstringifiable(input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input);
  // Indices are not field names, so listing them would say less than the length does.
  if (Array.isArray(input)) return `<array of ${String(input.length)} that cannot be displayed>`;
  const keys = Object.keys(input);
  // No own fields to name, so there is nothing to add. `String` here would produce exactly the
  // `[object Object]` this function exists to avoid printing.
  if (keys.length === 0) return '<object that cannot be displayed>';
  return `<object that cannot be displayed; fields: ${keys.join(', ')}>`;
}

/**
 * Render a permission card's raw input for the fallback path, without ever throwing.
 *
 * This is what a card shows when no summariser could read the request, so it runs on the
 * inputs least likely to be well-formed — and it runs inside `render`. A throw there does not
 * degrade the card, it removes it, taking away the decision the operator opened it to make and
 * leaving a request pending with no way to answer it.
 *
 * `JSON.stringify` fails in two ways on a value typed `unknown`, and only one of them is a
 * return value: it returns `undefined` — not a string — for `undefined`, a function and a
 * symbol, and it THROWS on a circular structure and on a `BigInt`. `String` handles all five,
 * so it is the fallback for both.
 *
 * Bidi controls are spelled out here as they are on every other card surface, and this path
 * needs it most: a bidi control in a headline field is one of the reasons a summariser returns
 * null, so the input likeliest to reorder what the operator reads is exactly the input that
 * lands here. `JSON.stringify` escapes quotes, backslashes and the C0 controls, and leaves
 * every bidi control alone.
 */
export function permissionInputText(input: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    // `String` throws too, on an object whose `toString` and `valueOf` both do — and this
    // branch is already reached only because `JSON.stringify` threw, so a `toJSON` that throws
    // makes that combination reachable from one object. `Object.keys` can throw as well, on a
    // Proxy with a hostile `ownKeys`. Nothing below may throw, so the last resort names the
    // type and stops.
    try {
      rendered = describeUnstringifiable(input);
    } catch {
      rendered = `<${typeof input} that cannot be displayed>`;
    }
  }
  return spellOutBidiControls(rendered);
}
