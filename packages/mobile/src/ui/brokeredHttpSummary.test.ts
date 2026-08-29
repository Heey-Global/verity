import { describe, expect, it } from 'vitest';

import {
  brokeredAuthSentence,
  brokeredHttpSummary,
  brokeredHttpTitle,
} from './brokeredHttpSummary.js';

describe('brokeredHttpSummary', () => {
  it('describes a static credential as the thing that travels to the API', () => {
    const summary = brokeredHttpSummary({
      method: 'POST',
      url: 'https://api.example.com/v1/things?dry=1',
      secretAlias: 'EXAMPLE_TOKEN',
      auth: { header: 'authorization', scheme: 'Bearer' },
      body: { name: 'thing' },
    });
    expect(summary?.auth).toEqual({ kind: 'static', header: 'authorization', scheme: 'Bearer' });
    expect(summary?.host).toBe('api.example.com');
    expect(summary?.path).toBe('/v1/things?dry=1');
    expect(brokeredHttpTitle(summary!)).toBe('Use secret EXAMPLE_TOKEN?');
    expect(brokeredAuthSentence(summary!)).toContain(
      'Verity sends EXAMPLE_TOKEN in the authorization header using Bearer to api.example.com.',
    );
  });

  it('shows the assertion a JWT request authorizes, not a token that is never sent', () => {
    const summary = brokeredHttpSummary({
      method: 'GET',
      url: 'https://api.appstoreconnect.apple.com/v1/apps',
      secretAlias: 'ASC_API_KEY_P8',
      auth: {
        kind: 'jwt',
        algorithm: 'ES256',
        keyId: { alias: 'ASC_API_KEY_ID' },
        issuer: { alias: 'ASC_API_ISSUER_ID' },
        audience: 'appstoreconnect-v1',
        expiresInSeconds: 900,
      },
    });
    expect(summary?.auth).toEqual({
      kind: 'jwt',
      algorithm: 'ES256',
      audience: 'appstoreconnect-v1',
      claims: [
        { claim: 'key id', source: 'from secret ASC_API_KEY_ID' },
        { claim: 'issuer', source: 'from secret ASC_API_ISSUER_ID' },
      ],
      expiresInSeconds: 900,
    });
    // The named secret is a signing key. Saying it is "sent in the authorization
    // header" would describe the one thing that provably does not happen.
    expect(brokeredHttpTitle(summary!)).toBe('Sign with key ASC_API_KEY_P8?');
    const sentence = brokeredAuthSentence(summary!);
    expect(sentence).toBe(
      'Verity signs a ES256 assertion with the private key ASC_API_KEY_P8 and sends it to ' +
        'api.appstoreconnect.apple.com as authorization: Bearer. Audience appstoreconnect-v1, ' +
        'key id from secret ASC_API_KEY_ID, issuer from secret ASC_API_ISSUER_ID; valid for 900 ' +
        'seconds. The key itself never leaves the server; the agent gets the status and the ' +
        'response with every named secret redacted.',
    );
  });

  it('carries public literals and a scope claim through as written', () => {
    const summary = brokeredHttpSummary({
      // The self-signed assertion Google accepts directly as a bearer token, not
      // the form-encoded token exchange — that one this JSON contract cannot
      // express, so it must not appear as an example of what it does.
      url: 'https://pubsub.googleapis.com/v1/projects/example/topics',
      secretAlias: 'GCP_SA_KEY',
      auth: {
        kind: 'jwt',
        algorithm: 'RS256',
        issuer: { literal: 'ci@example.iam.gserviceaccount.com' },
        subject: { literal: 'ci@example.iam.gserviceaccount.com' },
        audience: 'https://pubsub.googleapis.com/',
        scope: 'https://www.googleapis.com/auth/pubsub',
      },
    });
    expect(summary?.auth).toMatchObject({
      claims: [
        { claim: 'issuer', source: 'ci@example.iam.gserviceaccount.com' },
        { claim: 'subject', source: 'ci@example.iam.gserviceaccount.com' },
        { claim: 'scope', source: 'https://www.googleapis.com/auth/pubsub' },
      ],
      // Unnamed: the server applies the contract default. Restating a number
      // here would be a second copy of it, free to drift from the real one.
      expiresInSeconds: null,
    });
    expect(brokeredAuthSentence(summary!)).toContain("valid for Verity's default lifetime");
  });

  it('refuses to build a sentence out of display-deceptive text', () => {
    const jwt = (auth: Record<string, unknown>): unknown => ({
      url: 'https://api.appstoreconnect.apple.com/v1/apps',
      secretAlias: 'ASC_API_KEY_P8',
      auth: {
        kind: 'jwt',
        algorithm: 'ES256',
        issuer: { alias: 'ASC_API_ISSUER_ID' },
        audience: 'appstoreconnect-v1',
        ...auth,
      },
    });
    // U+202E reverses the display order of what follows, U+200D hides a word
    // boundary, and a newline breaks the one-line sentence into what reads as two
    // statements. Each would let the card describe an assertion other than the one
    // being signed, so the card is not rendered at all — the operator falls back
    // to the escaped raw tool view instead of approving crafted prose.
    for (const deceptive of [
      'appstoreconnect-v1\u202Enimda-lanretni',
      'appstoreconnect\u200D-v1',
      'appstoreconnect-v1\nAudience internal-admin',
      'appst\u043Ereconnect-v1',
    ]) {
      expect(brokeredHttpSummary(jwt({ audience: deceptive })), deceptive).toBeNull();
      expect(brokeredHttpSummary(jwt({ scope: deceptive })), deceptive).toBeNull();
      expect(brokeredHttpSummary(jwt({ issuer: { literal: deceptive } })), deceptive).toBeNull();
      expect(brokeredHttpSummary(jwt({ algorithm: deceptive })), deceptive).toBeNull();
      expect(
        brokeredHttpSummary({
          url: 'https://api.example.com/v1/things',
          secretAlias: 'EXAMPLE_TOKEN',
          auth: { header: 'authorization', scheme: deceptive },
        }),
        deceptive,
      ).toBeNull();
      expect(
        brokeredHttpSummary({
          url: 'https://api.example.com/v1/things',
          secretAlias: deceptive,
          auth: { header: 'authorization', scheme: 'Bearer' },
        }),
        deceptive,
      ).toBeNull();
    }
    // Whatever does render must be safe to read as one line, so the guard is
    // asserted on the sentence itself rather than only on the fields feeding it.
    const summary = brokeredHttpSummary(jwt({ scope: 'https://www.googleapis.com/auth/pubsub' }));
    expect(summary).not.toBeNull();
    expect(brokeredAuthSentence(summary!)).toMatch(/^[\x20-\x7e]+$/u);
    // `x-api-key` genuinely carries no scheme; null must stay a rendered card.
    expect(
      brokeredHttpSummary({
        url: 'https://api.example.com/v1/things',
        secretAlias: 'EXAMPLE_TOKEN',
        auth: { header: 'x-api-key', scheme: null },
      }),
    ).not.toBeNull();
  });

  it('summarizes nothing rather than part of an auth block it cannot read', () => {
    const jwt = (auth: Record<string, unknown>): unknown => ({
      url: 'https://api.appstoreconnect.apple.com/v1/apps',
      secretAlias: 'ASC_API_KEY_P8',
      auth: { kind: 'jwt', algorithm: 'ES256', audience: 'appstoreconnect-v1', ...auth },
    });
    // A claim present but unreadable must not be silently dropped: the card
    // would then show an assertion narrower than the one being signed.
    expect(brokeredHttpSummary(jwt({ issuer: { alias: 'ISS' }, subject: {} }))).toBeNull();
    expect(brokeredHttpSummary(jwt({ issuer: 42 }))).toBeNull();
    expect(brokeredHttpSummary(jwt({}))).toBeNull();
    expect(
      brokeredHttpSummary(jwt({ issuer: { alias: 'ISS' }, expiresInSeconds: 'soon' })),
    ).toBeNull();
    // Static auth is required to name its header, so a missing one is a request
    // that never validated — not one that defaults to `authorization`.
    expect(
      brokeredHttpSummary({
        url: 'https://api.example.com/v1',
        secretAlias: 'EXAMPLE_TOKEN',
        auth: { scheme: 'Bearer' },
      }),
    ).toBeNull();
    expect(
      brokeredHttpSummary({ url: 'https://api.example.com/v1', secretAlias: 'EXAMPLE_TOKEN' }),
    ).toBeNull();
    expect(
      brokeredHttpSummary({
        url: 'not a url',
        secretAlias: 'EXAMPLE_TOKEN',
        auth: { header: 'x-api-key', scheme: null },
      }),
    ).toBeNull();
    expect(brokeredHttpSummary(null)).toBeNull();
  });
});
