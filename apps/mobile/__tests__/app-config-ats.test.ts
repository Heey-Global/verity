import config from '../app.config';

const ats = (config.ios?.infoPlist?.NSAppTransportSecurity ?? {}) as Record<string, unknown>;

describe('iOS App Transport Security', () => {
  it('leaves ATS off so a pinned private-CA server stays reachable', () => {
    // With ATS enabled, CFNetwork re-runs the system trust evaluation after
    // CertificatePinDelegate has already accepted the server. A pairing CA fails
    // it and the connection dies with NSURLErrorDomain:-1200 — on a device only,
    // because ATS exempts loopback and every simulator test talks to 127.0.0.1.
    expect(ats.NSAllowsArbitraryLoads).toBe(true);
  });

  it('keeps NSAllowsLocalNetworking out of the dictionary', () => {
    // iOS 10 and later ignore NSAllowsArbitraryLoads — using the default NO
    // instead — whenever this key is present. Adding it back would restore full
    // ATS enforcement while the plist still reads as though loads were allowed.
    expect(ats).not.toHaveProperty('NSAllowsLocalNetworking');
  });

  it('keeps the update host under full ATS enforcement', () => {
    // An exception domain overrides the global key for that host even when its
    // dictionary is empty. Verity chooses its own update endpoint, so unlike a
    // paired server it can be held to the system trust store.
    const updateHost = new URL(config.updates?.url ?? '').hostname;
    expect(Object.keys(ats.NSExceptionDomains ?? {})).toContain(updateHost);
  });
});

describe('iOS GitHub callback association', () => {
  it('claims the callback host for both routing and HTTPS authentication sessions', () => {
    // `applinks` alone opens Universal Links, but ASWebAuthenticationSession
    // rejects its HTTPS callback before presentation unless the same host is
    // also present under `webcredentials` in the signed entitlement.
    expect(config.ios?.associatedDomains).toEqual([
      'applinks:verity.build',
      'webcredentials:verity.build',
    ]);
  });
});

describe('iOS live meeting background capture', () => {
  it('targets an iOS release that supports background inference', () => {
    // The inference entitlement is only available from iOS 27; an iOS 26
    // release profile rejects it during archive signing.
    expect(Number(config.ios?.deploymentTarget)).toBeGreaterThanOrEqual(27);
  });

  it('keeps microphone capture eligible to continue after an app switch or screen lock', () => {
    // Without the audio mode, recording stops on device while foreground tests stay green.
    expect(config.ios?.infoPlist?.UIBackgroundModes).toContain('audio');
  });

  it('keeps Neural Engine inference eligible while meeting models run in the background', () => {
    // Audio background mode alone does not grant an in-app model access to the Neural Engine.
    expect(
      config.ios?.entitlements?.[
        'com.apple.developer.background-tasks.continued-processing.inference'
      ],
    ).toBe(true);
  });
});
