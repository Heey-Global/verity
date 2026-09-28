import { sessionLoadError } from './sessionLoadError';

describe('session load errors', () => {
  it('explains the direct TLS failure shown on the sessions start screen', () => {
    const result = sessionLoadError(
      'Direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    );
    expect(result.summary).toContain('Core is unreachable at the paired address');
    expect(result.details).toContain('NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE');
    expect(result.summary).not.toContain('NSURLErrorDomain');
  });

  it('identifies when the Uplink route is missing and keeps raw error text private', () => {
    const result = sessionLoadError(
      'Uplink routing (no remote descriptor saved) and direct Core request failed: secret-token',
    );
    expect(result.summary).toContain('no saved Remote Control route');
    expect(result.details).toContain('No saved Remote Control route');
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it.each([
    ['missing device authentication', 'not signed in', 'Device authentication unavailable'],
    [
      'no matching paired endpoint',
      'saved server address',
      'Request does not match the paired endpoint',
    ],
    ['no direct pinned endpoint', 'saved server address', 'No pinned direct endpoint'],
  ])('explains why remote routing was skipped: %s', (reason, summary, detail) => {
    const result = sessionLoadError(
      `Uplink routing (${reason}) and direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]`,
    );
    expect(result.summary).toContain(summary);
    expect(result.summary).not.toContain('Both Uplink');
    expect(result.details).toContain(detail);
    expect(result.details).toContain('NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE');
  });

  it('distinguishes an attempted Uplink admission from a direct-only failure', () => {
    const result = sessionLoadError(
      'Uplink admission (Remote admission failed: unavailable.) and direct Core request failed: secret',
    );
    expect(result.summary).toContain('Both Uplink and the direct Core connection failed');
    expect(result.details).toContain('Admission: unavailable');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('explains when an Uplink request and its direct retry both fail', () => {
    const result = sessionLoadError('Uplink and direct Core requests failed: secret');
    expect(result.summary).toContain('Both Uplink and the direct Core connection failed');
    expect(result.details).toContain('Uplink request failed');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
