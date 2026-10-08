import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets, redactProcessStderr } from './redact.js';

// The fixtures below are synthetic, but a credential-shaped literal trips the secret
// scanners that run over this repository and over anything published from it. So each
// one is assembled at run time from a prefix and a body held in a named constant, and
// no source line pairs a credential keyword with a random-looking literal — that
// adjacency is itself what a generic API-key rule matches, independent of whether the
// value is real or split across two strings.
const BODY = 'abcDEF123456789ghiJKL';
const ALPHANUM_RUN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAT_BODY = '11ABCDE0000fGhIjKlMnOp_qRsTuVwXyZ0123456789';
const DOPPLER_BODY = 'abcDEF123456ghiJKL789';
const SLACK_BODY = '1234567890-ABCDEFghij';
const AWS_PLACEHOLDER = 'IOSFODNN7EXAMPLE';

describe('redactSecrets (M9)', () => {
  it('masks well-known credential shapes', () => {
    const cases = [
      ['sk-ant-oat01-', BODY].join(''),
      ['sk-ant-api03-', BODY].join(''),
      ['ghp_', ALPHANUM_RUN].join(''),
      ['github_pat_', PAT_BODY].join(''),
      ['dp.st.prod.', DOPPLER_BODY].join(''),
      ['xoxb-', SLACK_BODY].join(''),
      ['AKIA', AWS_PLACEHOLDER].join(''),
    ];
    for (const secret of cases) {
      const out = redactSecrets(`token is ${secret} end`);
      expect(out).toContain(REDACTED);
      expect(out).not.toContain(secret);
    }
  });

  it('masks an armored OpenSSH private key block wholesale', () => {
    const key = [
      ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAA',
      'notarealkeybody',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`before\n${key}\nafter`);
    expect(out).toBe(`before\n${REDACTED}\nafter`);
    expect(out).not.toContain('notarealkeybody');
  });

  it('redacts a secret embedded in a JSON-serialized payload, keeping it valid JSON', () => {
    const payload = JSON.stringify({
      t: 'tool_result',
      output: `DOPPLER_TOKEN=${['dp.st.prod.', DOPPLER_BODY].join('')}\nHOME=/home/dev`,
    });
    const redacted = redactSecrets(payload);
    expect(redacted).not.toContain(['dp.st.prod.', DOPPLER_BODY].join(''));
    const parsed = JSON.parse(redacted) as { t: string; output: string };
    expect(parsed.t).toBe('tool_result');
    expect(parsed.output).toContain(REDACTED);
    expect(parsed.output).toContain('HOME=/home/dev');
  });

  it('leaves ordinary transcript text untouched', () => {
    const text = 'Refactored the auth gate; ran npm test — 42 passed. See PR #123.';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactProcessStderr', () => {
  it('redacts credential patterns, child environment values and environment assignments', () => {
    const value = ['opaque', 'child', 'credential'].join('-');
    const known = ['ghp_', ALPHANUM_RUN].join('');
    const result = redactProcessStderr(
      `failure ${value} ${known}\nPATH=/private/path\nAuthorization: Bearer unknown\nlast failure`,
      { CUSTOM_VALUE: value },
    );
    expect(result).not.toContain(value);
    expect(result).not.toContain(known);
    expect(result).not.toContain('/private/path');
    expect(result).not.toContain('unknown');
    expect(result).toContain('last failure');
  });
  it('redacts credentials loaded from files, including bare and JSON JWTs', () => {
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'c2lnbmF0dXJl'].join('.');
    const raw = `failure ${jwt}\n${JSON.stringify({ access_token: jwt })}`;
    const redacted = redactProcessStderr(raw);
    expect(redacted).not.toContain(jwt);
    expect(redacted).toContain('[REDACTED JWT]');
  });
  it.each([
    'access_token',
    'refresh_token',
    'password',
    'api_key',
    'client_secret',
    'CUSTOM_TOKEN',
    'authorization',
  ])('redacts an opaque credential in the JSON field %s', (field) => {
    const value = ['opaque', 'file', 'credential'].join('-');
    const raw = `${JSON.stringify({ [field]: value })}\nlast failure`;
    const redacted = redactProcessStderr(raw);
    expect(redacted).not.toContain(value);
    expect(redacted).toContain('[REDACTED CREDENTIAL FIELD]');
    expect(redacted).toContain('last failure');
  });
  it('redacts quoted credential values even when JSON is truncated', () => {
    const value = ['opaque', 'file', 'credential'].join('-');
    expect(redactProcessStderr(`{"password":"${value}`)).not.toContain(value);
  });
  it('omits a leading partial credential line from a full capture', () => {
    const raw = 'partial-credential' + 'x'.repeat(65_536) + '\nlast failure';
    expect(redactProcessStderr(raw)).toBe('last failure');
    expect(redactProcessStderr('x'.repeat(65_536))).toBe('[truncated stderr line omitted]');
  });
  it('suppresses partial private key armor', () => {
    expect(redactProcessStderr('keybody\n-----END OPENSSH PRIVATE KEY-----')).toBe(
      '[REDACTED PARTIAL PRIVATE KEY]',
    );
  });
});
