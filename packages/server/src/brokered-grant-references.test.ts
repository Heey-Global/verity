import { describe, expect, it } from 'vitest';
import { brokeredGrantReferences } from './brokered-grant-references.js';

// A grant check without a binding derives the binding from these references. Missing
// one lets a grant for the prompted alias's binding cover reads from another binding.
describe('references for a standing-grant check without a binding', () => {
  it('includes every alias a secret run reads, not only the prompted one', () => {
    const request = {
      command: ['node', 'deploy.mjs'],
      secrets: [
        { secretAlias: 'portal/prd/API_KEY', env: 'API_KEY' },
        { secretAlias: 'billing/dev/TOKEN', env: 'TOKEN' },
      ],
    };
    expect(brokeredGrantReferences('verity_secret_run', request, 'portal/prd/API_KEY')).toEqual([
      'portal/prd/API_KEY',
      'billing/dev/TOKEN',
    ]);
  });

  it('includes JWT claim references of an HTTP request', () => {
    const request = {
      method: 'GET',
      url: 'https://api.example.com/v1',
      secretAlias: 'portal/prd/SIGNING_KEY',
      auth: {
        kind: 'jwt',
        algorithm: 'ES256',
        issuer: { alias: 'billing/dev/ISSUER' },
        audience: 'appstoreconnect-v1',
      },
    };
    const references = brokeredGrantReferences(
      'verity_http_request',
      request,
      'portal/prd/SIGNING_KEY',
    );
    expect(references).toEqual(expect.arrayContaining(['portal/prd/SIGNING_KEY']));
    expect(references).toEqual(expect.arrayContaining(['billing/dev/ISSUER']));
  });

  it('fails closed on unreadable input or a call that does not read the prompted alias', () => {
    expect(brokeredGrantReferences('verity_secret_run', undefined, 'API_KEY')).toBeUndefined();
    expect(
      brokeredGrantReferences('verity_secret_run', { secrets: [{ secretAlias: 7 }] }, 'API_KEY'),
    ).toBeUndefined();
    expect(
      brokeredGrantReferences(
        'verity_secret_run',
        { secrets: [{ secretAlias: 'OTHER' }] },
        'API_KEY',
      ),
    ).toBeUndefined();
  });
});
