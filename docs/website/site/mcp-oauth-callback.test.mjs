import { URL } from 'node:url';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mcpAppReturnUrl } from './mcp-oauth-callback.js';
const state = 's'.repeat(43);
test('returns only to the fixed production or staging app callback', () => {
  for (const [prefix, scheme] of [['', 'verity'], ['staging.', 'verity-staging']]) {
    const url = new URL(mcpAppReturnUrl(`?state=${prefix}${state}&code=a%2Bb&returnTo=https://evil.example`));
    assert.equal(url.protocol, `${scheme}:`);
    assert.equal(url.hostname, 'mcp');
    assert.equal(url.pathname, '/oauth/callback');
    assert.equal(url.searchParams.get('code'), 'a+b');
    assert.equal(url.searchParams.has('returnTo'), false);
  }
});
test('handles provider rejection and rejects malformed or unbounded callbacks', () => {
  assert.equal(new URL(mcpAppReturnUrl(`?state=${state}&error=access_denied`)).searchParams.get('error'), 'access_denied');
  for (const query of ['?code=code', `?state=${state}`, '?state=invalid&code=code', `?state=${state}&code=${'x'.repeat(8193)}`]) assert.equal(mcpAppReturnUrl(query), null);
});
test('ships the bridge with a same-origin script policy and no callback access logging', () => {
  const nginx = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./mcp-oauth-callback.html', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert.ok(script);
  assert.ok(dockerfile.includes(`/usr/share/nginx/html${script}`));
  const callbackBlock = nginx.split('location = /mcp/oauth/callback {')[1].split('\n  }')[0];
  assert.match(callbackBlock, /access_log off/);
  assert.match(callbackBlock, /script-src 'self'/);
  assert.match(callbackBlock, /no-referrer/);
});
