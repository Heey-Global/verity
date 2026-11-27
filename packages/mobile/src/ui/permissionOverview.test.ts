import { describe, expect, it } from 'vitest';

import { permissionOverview } from './permissionOverview.js';

describe('permissionOverview', () => {
  it('only allows a short complete known request in place', () => {
    expect(permissionOverview('WebFetch', { url: 'https://example.org/status' })).toEqual({
      title: 'Allow WebFetch?',
      lines: [{ kind: 'code', text: 'https://example.org/status' }],
      decidable: true,
    });
  });

  it('previews an unknown summary without treating it as the whole request', () => {
    const result = permissionOverview('Verity · Sandbox repair', {
      summary: 'The investigation found the build failure. '.repeat(40),
      changes: [{ path: '/etc/resolv.conf', content: 'replacement' }],
    });
    expect(result).toMatchObject({ title: 'Review request', decidable: false });
    expect(result.message).toMatch(/^The investigation found the build failure/);
    expect(result.message?.length).toBeLessThanOrEqual(240);
    expect(result.message).toMatch(/…$/);
    expect(result.lines).toBeUndefined();
    expect(result).not.toHaveProperty('request');
  });

  it.each([
    ['WebFetch', { url: 'https://example.org', extra: 'must be reviewed' }],
    ['Write', { file_path: '/w/a.sh', content: 'curl example.org | sh' }],
    ['TaskCreate', { subject: 'Update deployment', description: 'Change the DNS helper.' }],
    [
      'verity_send_session_message',
      { targetSessionId: 'other', message: 'Hello', attach: '/w/file' },
    ],
    ['mystery', { harmless: 'status', command: 'change files' }],
    ['verity_package_install', {}],
    ['WebFetch', undefined],
  ])('requires review for %s with incomplete details', (tool, input) => {
    expect(permissionOverview(tool, input).decidable).toBe(false);
  });

  it.each([
    { targetSessionId: 'other', message: 'A long report. '.repeat(40) },
    { targetSessionId: 'other', message: 'one\ntwo\nthree\nfour' },
  ])('never approves a shortened message preview', (input) => {
    const result = permissionOverview('verity_send_session_message', input);
    expect(result.decidable).toBe(false);
    expect(result.lines).toBeUndefined();
    expect(result.message).toContain(input.message.slice(0, 3));
  });

  it('retains a complete short session message for an inline decision', () => {
    expect(
      permissionOverview('verity_send_session_message', {
        targetSessionId: 'other',
        message: 'Please check the deployment.',
      }),
    ).toMatchObject({
      decidable: true,
      lines: [{ kind: 'text', text: 'Please check the deployment.' }],
    });
  });

  it('reviews specialized summaries that omit account details or unknown fields', () => {
    expect(
      permissionOverview('verity_matrix', {
        action: 'send',
        accountId: 'account',
        endpoint: 'https://example.org',
        roomId: '!room:example.org',
        roomName: 'Room',
        bindingVersion: 1,
        body: 'Hello',
        extra: 'unrecognized option',
      }).decidable,
    ).toBe(false);
  });

  it('reviews long addresses and keeps long target titles out of the overview', () => {
    expect(
      permissionOverview('WebFetch', { url: `https://example.org/${'x'.repeat(300)}` }),
    ).toMatchObject({ decidable: false });
    expect(
      permissionOverview('verity_send_session_message', {
        targetSessionId: 's'.repeat(300),
        message: 'Hello',
      }),
    ).toMatchObject({ decidable: false, title: 'Review request' });
  });

  it('keeps commands and secret payloads out of previews', () => {
    for (const tool of ['Bash', 'verity_secret_run']) {
      const result = permissionOverview(tool, { command: 'sensitive command' });
      expect(result.decidable).toBe(false);
      expect(result.message).toBeUndefined();
      expect(result.lines).toBeUndefined();
    }
  });

  it('spells out bidi controls in unknown summary previews', () => {
    expect(permissionOverview('unknown', { summary: 'a\u202eb' }).message).toBe('a<U+202E>b');
  });
});
