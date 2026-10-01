import { describe, expect, it, vi } from 'vitest';
import { googleContactsRequestSchema, invokeGoogleContactsApi } from './google-contacts.js';
import { createGoogleContactsTool } from './google-contacts-tool.js';

describe('Google Contacts lookup', () => {
  it('warms the search cache and requests only bounded names and email addresses', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              person: {
                resourceName: 'people/1',
                names: [{ displayName: 'Jane' }],
                emailAddresses: [{ value: 'jane@example.test' }],
                birthdays: ['private'],
              },
            },
          ],
        }),
      });
    expect(
      await invokeGoogleContactsApi(
        'token',
        googleContactsRequestSchema.parse({ action: 'search_contacts', query: 'Jane' }),
        fetch,
      ),
    ).toEqual({
      contacts: [
        { resourceName: 'people/1', names: ['Jane'], emailAddresses: ['jane@example.test'] },
      ],
    });
    expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('query')).toBe('');
    const url = new URL(fetch.mock.calls[1]![0] as string);
    expect(url.searchParams.get('readMask')).toBe('names,emailAddresses');
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(url.searchParams.get('query')).toBe('Jane');
  });
  it('rejects contact writes, empty searches, and excessive result counts', () => {
    for (const request of [
      { action: 'create_contact', query: 'Jane' },
      { action: 'search_contacts', query: '' },
      { action: 'search_contacts', query: 'Jane', maxResults: 21 },
    ])
      expect(googleContactsRequestSchema.safeParse(request).success).toBe(false);
  });
  it('rejects a revoked session grant after token retrieval', async () => {
    const contacts = vi.fn();
    const tool = createGoogleContactsTool({
      contacts,
      googleAccessToken: async () => 'token',
      eventStore: {
        getSession: vi.fn().mockResolvedValue({ projectId: 'p' }),
        getSessionContactsConnection: vi
          .fn()
          .mockResolvedValueOnce({ accountEmail: 'me@example.test' })
          .mockResolvedValueOnce(undefined),
        getVeritySettings: vi.fn().mockResolvedValue({
          contactsAuthorized: true,
          googleDriveRefreshToken: 'refresh',
          googleDriveAccountEmail: 'me@example.test',
        }),
      },
    });
    await expect(
      tool.invoke({
        projectId: 'p',
        sessionId: 's',
        turnId: 't',
        invocationId: 'i',
        request: { action: 'search_contacts', query: 'Jane' },
      }),
    ).rejects.toThrow('not enabled');
    expect(contacts).not.toHaveBeenCalled();
  });
  it('does not start the query when the session disconnects during cache warmup', async () => {
    let enabled = true;
    const fetch = vi.fn().mockImplementation(async () => {
      enabled = false;
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const tool = createGoogleContactsTool({
        googleAccessToken: async () => 'token',
        eventStore: {
          getSession: vi.fn().mockResolvedValue({ projectId: 'p' }),
          getSessionContactsConnection: vi.fn(async () =>
            enabled ? { accountEmail: 'me@example.test', enabledAt: new Date() } : undefined,
          ),
          getVeritySettings: vi.fn().mockResolvedValue({
            contactsAuthorized: true,
            googleDriveRefreshToken: 'refresh',
            googleDriveAccountEmail: 'me@example.test',
          }),
        },
      });
      await expect(
        tool.invoke({
          projectId: 'p',
          sessionId: 's',
          turnId: 't',
          invocationId: 'i',
          request: { action: 'search_contacts', query: 'Jane' },
        }),
      ).rejects.toThrow('not enabled');
      expect(fetch).toHaveBeenCalledOnce();
      expect(new URL(fetch.mock.calls[0]![0] as string).searchParams.get('query')).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
