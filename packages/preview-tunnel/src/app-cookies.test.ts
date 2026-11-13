import { describe, expect, it } from 'vitest';

import {
  APP_COOKIE_PREFIX,
  MAX_COOKIE_ATTRIBUTE_VALUE_BYTES,
  MAX_COOKIE_PAIR_BYTES,
  MAX_RELAYED_SET_COOKIE_BYTES,
  MAX_RELAYED_SET_COOKIE_CHARACTERS,
  MAX_RELAYED_SET_COOKIES,
  RELAYED_SET_COOKIE_OVERHEAD_BYTES,
  appRequestCookies,
  boundedSetCookies,
  namespaceSetCookie,
} from './app-cookies.js';

// The edge's own PIN session cookie; the application must never produce it.
const EDGE_COOKIE = '__Host-verity-preview';

function cookieName(line: string | undefined): string | undefined {
  return line?.split('=', 1)[0];
}

describe('namespaceSetCookie', () => {
  it('moves the cookie into the __Host-app- namespace with the attributes __Host- requires', () => {
    expect(namespaceSetCookie('sid=abc; Domain=share.verity.build; Path=/admin')).toBe(
      `${APP_COOKIE_PREFIX}sid=abc; Path=/; Secure`,
    );
  });

  it('keeps validated lifetime and browser attributes and drops unknown ones', () => {
    expect(
      namespaceSetCookie(
        'sid="v"; max-age=3600; expires=Wed, 21 Oct 2037 07:28:00 GMT; httponly; samesite=none; partitioned; priority=high; Secure; Foo=bar',
      ),
    ).toBe(
      `${APP_COOKIE_PREFIX}sid="v"; Path=/; Secure; Max-Age=3600; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; SameSite=None; Partitioned; Priority=High`,
    );
  });

  it('drops malformed attribute values instead of forwarding them', () => {
    for (const expires of ['1', '0', '2037-10-21', 'Wed, 21 Oct 2037'])
      expect(namespaceSetCookie(`a=b; Expires=${expires}`), expires).toBe(
        `${APP_COOKIE_PREFIX}a=b; Path=/; Secure`,
      );
    expect(namespaceSetCookie('a=b; Expires=Sunday, 06-Nov-94 08:49:37 GMT')).toBe(
      `${APP_COOKIE_PREFIX}a=b; Path=/; Secure; Expires=Sun, 06 Nov 1994 08:49:37 GMT`,
    );
    expect(
      namespaceSetCookie('a=b; Max-Age=soon; Expires=never; SameSite=Sometimes; Priority=x'),
    ).toBe(`${APP_COOKIE_PREFIX}a=b; Path=/; Secure`);
  });

  it('keeps deletions so a logout clears the cookie that was set', () => {
    expect(namespaceSetCookie('sid=; Path=/app; Max-Age=0')).toBe(
      `${APP_COOKIE_PREFIX}sid=; Path=/; Secure; Max-Age=0`,
    );
    expect(namespaceSetCookie('sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT')).toBe(
      `${APP_COOKIE_PREFIX}sid=x; Path=/; Secure; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    );
  });

  it('never yields the edge session cookie, whatever name the application uses', () => {
    for (const name of [EDGE_COOKIE, 'verity-preview', '__Host-verity_session', '-verity-preview'])
      expect(cookieName(namespaceSetCookie(`${name}=x`))).not.toBe(EDGE_COOKIE);
    expect(cookieName(namespaceSetCookie(`${EDGE_COOKIE}=x`))).toBe(
      `${APP_COOKIE_PREFIX}${EDGE_COOKIE}`,
    );
  });

  it('drops cookies with invalid names or values', () => {
    for (const line of ['', '=x', 'x', 'a b=c', 'a,b=c', 'a=b c', 'a=b,c', 'a="b', 'a=\\b', 'é=x'])
      expect(namespaceSetCookie(line), line).toBeUndefined();
  });

  it('counts the prefix against the browser per-cookie size limit', () => {
    const room = MAX_COOKIE_PAIR_BYTES - APP_COOKIE_PREFIX.length - 'n'.length;
    expect(namespaceSetCookie(`n=${'v'.repeat(room)}`)).toBeDefined();
    expect(namespaceSetCookie(`n=${'v'.repeat(room + 1)}`)).toBeUndefined();
  });

  it('ignores attributes whose value exceeds the browser attribute limit', () => {
    const long = '1'.repeat(MAX_COOKIE_ATTRIBUTE_VALUE_BYTES + 1);
    expect(namespaceSetCookie(`a=b; Max-Age=${long}`)).toBe(
      `${APP_COOKIE_PREFIX}a=b; Path=/; Secure`,
    );
  });
});

describe('appRequestCookies', () => {
  it('restores application names in order and keeps duplicates', () => {
    expect(
      appRequestCookies(
        `${APP_COOKIE_PREFIX}b=2; ${APP_COOKIE_PREFIX}a="1"; ${APP_COOKIE_PREFIX}b=3;${APP_COOKIE_PREFIX}__Host-x=y`,
      ),
    ).toBe('b=2; a="1"; b=3; __Host-x=y');
  });

  it('drops the edge session, Core and sibling-planted cookies', () => {
    expect(
      appRequestCookies(
        `${EDGE_COOKIE}=v1.1.s; __Host-verity_session=core; sid=evil; __host-app-sid=evil; __HOST-APP-sid=evil; ${APP_COOKIE_PREFIX}=empty; ${APP_COOKIE_PREFIX}a b=bad; ${APP_COOKIE_PREFIX}novalue`,
      ),
    ).toBe('');
  });
});

describe('boundedSetCookies', () => {
  it('skips lines the tunnel would refuse and keeps the rest in order', () => {
    const huge = `big=${'x'.repeat(MAX_RELAYED_SET_COOKIE_CHARACTERS)}`;
    expect(boundedSetCookies(['a=1', huge, 'b=2'])).toEqual(['a=1', 'b=2']);
  });

  it('stops at the count budget', () => {
    const lines = Array.from({ length: MAX_RELAYED_SET_COOKIES + 5 }, (_, index) => `c${index}=1`);
    expect(boundedSetCookies(lines)).toEqual(lines.slice(0, MAX_RELAYED_SET_COOKIES));
  });

  it('stops at the byte budget', () => {
    const line = `c=${'x'.repeat(4000)}`;
    const relayed = boundedSetCookies(Array.from({ length: 10 }, () => line));
    expect(relayed.length).toBe(
      Math.floor(MAX_RELAYED_SET_COOKIE_BYTES / (line.length + RELAYED_SET_COOKIE_OVERHEAD_BYTES)),
    );
  });

  it('counts the UTF-8 bytes the tunnel will measure', () => {
    // A latin1-decoded byte above 0x7F encodes to two UTF-8 bytes.
    const line = `c=${'\u00e9'.repeat(100)}`;
    const cost = Buffer.byteLength(line) + RELAYED_SET_COOKIE_OVERHEAD_BYTES;
    expect(boundedSetCookies([line, line], { headers: Infinity, bytes: cost })).toEqual([line]);
  });

  it('stays within the room the other response headers leave', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `c${index}=1`);
    expect(boundedSetCookies(lines, { headers: 3, bytes: Infinity })).toEqual(lines.slice(0, 3));
    expect(
      boundedSetCookies(lines, {
        headers: Infinity,
        bytes: 2 * (4 + RELAYED_SET_COOKIE_OVERHEAD_BYTES),
      }),
    ).toEqual(lines.slice(0, 2));
    expect(boundedSetCookies(lines, { headers: 0, bytes: 0 })).toEqual([]);
  });
});
