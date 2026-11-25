import { CLIENT_HEADER, clientIdentity, withClientIdentity } from './clientIdentity';

jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.95.0' }));

describe('client identity', () => {
  it('names the platform and release, and the watch when the phone acts for it', () => {
    expect(clientIdentity('phone', 'ios', '1.95.4')).toBe('ios/1.95.4');
    expect(clientIdentity('phone', 'android', '1.95.4')).toBe('android/1.95.4');
    expect(clientIdentity('watch', 'ios', '1.95.4')).toBe('watch/1.95.4');
  });

  it('adds the header without dropping the request’s own headers or options', async () => {
    const base = jest.fn(async () => new Response('{}'));
    const identified = withClientIdentity(base as unknown as typeof fetch, 'ios/1.95.4');
    await identified('https://verity.example/sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: '{}',
    });
    const [url, init] = base.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://verity.example/sessions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    const headers = new Headers(init.headers);
    // Losing the bearer here would sign every request out, not just mislabel it.
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get(CLIENT_HEADER)).toBe('ios/1.95.4');
  });

  it('keeps the headers of a Request passed without options', async () => {
    const base = jest.fn(async () => new Response('{}'));
    await withClientIdentity(
      base as unknown as typeof fetch,
      'ios/1.95.4',
    )(new Request('https://x', { headers: { authorization: 'Bearer t' } }));
    const init = (base.mock.calls[0] as unknown as [Request, RequestInit])[1];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(headers.get(CLIENT_HEADER)).toBe('ios/1.95.4');
  });

  it('keeps a header the caller set itself', async () => {
    const base = jest.fn(async () => new Response('{}'));
    await withClientIdentity(base as unknown as typeof fetch, 'ios/1.95.4')('https://x', {
      headers: { [CLIENT_HEADER]: 'watch/1.95.4' },
    });
    const init = (base.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get(CLIENT_HEADER)).toBe('watch/1.95.4');
  });
});
