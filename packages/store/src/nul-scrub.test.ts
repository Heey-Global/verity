import { describe, expect, it } from 'vitest';
import { scrubNulEscapes } from './nul-scrub.js';

// Spelled through fromCharCode / concatenation rather than escapes, so this file
// stays free of the very byte under test and of anything an editor might helpfully
// "fix" — the fixtures must be exactly what an agent's output would carry.
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);
const BACKSLASH = String.fromCharCode(0x5c);
const LITERAL_ESCAPE = BACKSLASH + 'u0000';

describe('scrubNulEscapes', () => {
  it('leaves a payload without NUL untouched', () => {
    const payload = JSON.stringify({ t: 'text', delta: 'nothing unusual here' });
    expect(scrubNulEscapes(payload)).toBe(payload);
  });

  it('replaces a NUL with U+FFFD, keeping the payload valid JSON', () => {
    const payload = JSON.stringify({ t: 'text', delta: `before${NUL}after` });
    const scrubbed = scrubNulEscapes(payload);

    expect(scrubbed).not.toContain(NUL);
    expect(JSON.parse(scrubbed)).toEqual({ t: 'text', delta: `before${REPLACEMENT}after` });
  });

  it('replaces every NUL, not just the first', () => {
    const key = `install${NUL}scope${NUL}subject`;
    const parsed = JSON.parse(scrubNulEscapes(JSON.stringify({ t: 'text', delta: key }))) as {
      delta: string;
    };
    expect(parsed.delta).toBe(`install${REPLACEMENT}scope${REPLACEMENT}subject`);
  });

  // The distinction the parity rule exists for: source code that SPELLS the escape
  // serializes to the same six characters as a real NUL, one doubled backslash apart.
  // Rewriting it would corrupt ordinary text — the failure that made this a payload
  // rewrite rather than a blind string replace.
  it('preserves text that literally spells the escape sequence', () => {
    const source = `return \`\${ref.installationId}${LITERAL_ESCAPE}\${ref.scope}\`;`;
    const payload = JSON.stringify({ t: 'text', delta: source });

    expect(scrubNulEscapes(payload)).toBe(payload);
    expect(JSON.parse(scrubNulEscapes(payload))).toEqual({ t: 'text', delta: source });
  });

  it('scrubs a NUL that follows a literal backslash', () => {
    const delta = `path${BACKSLASH}${NUL}tail`;
    const parsed = JSON.parse(scrubNulEscapes(JSON.stringify({ t: 'text', delta }))) as {
      delta: string;
    };
    expect(parsed.delta).toBe(`path${BACKSLASH}${REPLACEMENT}tail`);
  });

  it('scrubs a NUL that follows text spelling the escape', () => {
    const delta = `${LITERAL_ESCAPE}${NUL}`;
    const parsed = JSON.parse(scrubNulEscapes(JSON.stringify({ t: 'text', delta }))) as {
      delta: string;
    };
    expect(parsed.delta).toBe(`${LITERAL_ESCAPE}${REPLACEMENT}`);
  });
});
