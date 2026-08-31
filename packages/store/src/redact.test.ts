import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from './redact.js';

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
