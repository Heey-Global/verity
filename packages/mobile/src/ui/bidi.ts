/**
 * Bidi controls, which reorder the text around them without being visible themselves.
 *
 * A permission card exists so the operator reads the request before it happens. A card read
 * in one order and dispatched in another fails at that one job, and nothing in the card's own
 * rendering betrays it: `JSON.stringify` escapes quotes, backslashes and the C0 controls, and
 * leaves every one of these alone.
 *
 * Only bidi controls, deliberately. A newline or a tab is ordinary formatting and renders as
 * itself; ZWJ, ZWNJ and the soft hyphen are needed to spell ordinary words and are left alone
 * too. U+2028 and U+2029 are left alone for the same reason: they break a line, they do not
 * reorder one, and the text this runs on may contain line breaks already.
 *
 * `cardLine` in `@verity/events` refuses a superset — these controls plus `\p{Cc}` and the two
 * separators — because it guards a single rendered line, where a newline is itself a way to
 * misdescribe a request. This runs on bodies of text, where it is not.
 */
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Replace each bidi control with its code point, spelled out where it sat.
 *
 * Annotates rather than filters: refusing to display text because one character is suspicious
 * would defeat the point of displaying it, so the card shows the same sequence the request
 * carries and says where the reordering was asked for.
 */
export function spellOutBidiControls(text: string): string {
  return text.replace(
    BIDI_CONTROL,
    (char) => `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}
