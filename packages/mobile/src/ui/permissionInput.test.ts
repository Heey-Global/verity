import { describe, expect, it } from 'vitest';

import { permissionInputText } from './permissionInput.js';

describe('permissionInputText', () => {
  it('pretty-prints an ordinary request', () => {
    expect(permissionInputText({ project: 'acme/website' })).toBe(
      '{\n  "project": "acme/website"\n}',
    );
  });

  it('spells out bidi controls, which JSON.stringify leaves invisible', () => {
    // The reason this path is hardened at all: a control here reorders the only rendering of
    // the request the operator gets, and it is the fallback precisely because a summariser
    // refused the input over that character.
    expect(permissionInputText({ title: 'a‮b' })).toContain('<U+202E>');
  });

  it.each([
    ['undefined', undefined, 'undefined'],
    ['a function', () => 0, '() => 0'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
  ])('renders %s, which JSON.stringify returns no string for', (_label, input, expected) => {
    expect(permissionInputText(input)).toContain(expected);
  });

  it('renders values JSON.stringify throws on rather than taking the card down', () => {
    // A throw inside render does not degrade the card, it removes it — and with it the
    // Allow/Deny the operator opened it to press.
    const circular: Record<string, unknown> = { tool: 'verity_session_handoff' };
    circular.self = circular;
    expect(() => permissionInputText(circular)).not.toThrow();
    // Named fields, not `[object Object]`. This is a card with an Allow button on it, and the
    // reason it fell back here is that no summariser could read the request — so a rendering
    // that contains none of the request reads like content while saying nothing. The values
    // are what cannot be shown; the field names still can be.
    expect(permissionInputText(circular)).toBe(
      '<object that cannot be displayed; fields: tool, self>',
    );
    expect(permissionInputText({ size: 1n })).toBe(
      '<object that cannot be displayed; fields: size>',
    );
    expect(permissionInputText([1n, 2n])).toBe('<array of 2 that cannot be displayed>');
  });

  it('survives an object whose own toString throws', () => {
    const hostile = {
      toJSON() {
        throw new Error('no');
      },
      toString() {
        throw new Error('no');
      },
    };
    // Its keys are still readable, so it never reaches the last resort — the two methods that
    // throw are simply the fields it has.
    expect(permissionInputText(hostile)).toBe(
      '<object that cannot be displayed; fields: toJSON, toString>',
    );
  });

  it('survives an object that will not even name its own keys', () => {
    // The last resort, and now the only way to it: `JSON.stringify` throws on the `toJSON`,
    // and `Object.keys` throws on the `ownKeys` trap. Nothing in this function may throw,
    // because a throw here removes the card rather than degrading it.
    const hostile = new Proxy(
      {
        toJSON() {
          throw new Error('no');
        },
      },
      {
        ownKeys() {
          throw new Error('no');
        },
      },
    );
    expect(permissionInputText(hostile)).toBe('<object that cannot be displayed>');
  });
});
