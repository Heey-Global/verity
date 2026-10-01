const mockRequest = jest.fn();
const mockRequestV2 = jest.fn();
let mockRequestV2Enabled = false;
const mockUpload = jest.fn();
const mockDownload = jest.fn();
const mockCancelRequest = jest.fn();
const mockRemotePort = jest.fn();
const mockRemoteFailure = jest.fn();
const mockReportDirectFailure = jest.fn();
const mockReportDirectSuccess = jest.fn();
const mockDirectVerdict = jest.fn();
const mockDirectRefusal = jest.fn();
const mockDirectKnownReachable = jest.fn();
const mockRecoverRemoteRead = jest.fn();

jest.mock('./remoteControlTransport', () => ({
  remoteControlPortForUrl: (...args: unknown[]) => mockRemotePort(...args),
  remoteControlFailureForUrl: (...args: unknown[]) => mockRemoteFailure(...args),
  reportDirectRouteSuccess: (...args: unknown[]) => mockReportDirectSuccess(...args),
  reportDirectRouteFailure: (...args: unknown[]) => mockReportDirectFailure(...args),
  pendingDirectVerdict: (...args: unknown[]) => mockDirectVerdict(...args),
  lastDirectRefusal: (...args: unknown[]) => mockDirectRefusal(...args),
  directRouteKnownReachable: (...args: unknown[]) => mockDirectKnownReachable(...args),
  recoverRemoteControlRead: (...args: unknown[]) => mockRecoverRemoteRead(...args),
}));

jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({
    request: mockRequest,
    get requestV2() {
      return mockRequestV2Enabled ? mockRequestV2 : undefined;
    },
    upload: mockUpload,
    download: mockDownload,
    cancelRequest: mockCancelRequest,
    verifyIdentity: jest.fn(),
    openWebSocket: jest.fn(),
    closeWebSocket: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  }),
}));

Object.defineProperty(globalThis, 'Response', {
  configurable: true,
  value: class TestResponse {
    constructor(
      readonly body: BodyInit | null,
      readonly init: ResponseInit,
    ) {}

    get status(): number {
      return this.init.status ?? 200;
    }
  },
});
Object.defineProperty(globalThis, 'Headers', {
  configurable: true,
  value: class TestHeaders {
    entries(): IterableIterator<[string, string]> {
      return new Map<string, string>().entries();
    }
  },
});
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: jest.fn(),
});

import { createPinnedFetch, downloadPinnedFile } from './pinnedTransport';

describe('pinned native file transport', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequestV2.mockReset();
    mockRequestV2Enabled = false;
    mockUpload.mockReset();
    mockDownload.mockReset();
    mockCancelRequest.mockReset();
    mockRemotePort.mockReset();
    mockRemoteFailure.mockReset().mockReturnValue(null);
    mockReportDirectFailure.mockReset();
    mockDirectVerdict.mockReset().mockReturnValue(null);
    mockDirectRefusal.mockReset().mockReturnValue(null);
    mockDirectKnownReachable.mockReset().mockReturnValue(false);
    mockRecoverRemoteRead.mockReset().mockResolvedValue(false);
    mockReportDirectSuccess.mockReset();
  });

  it('streams a file-backed Blob through the native upload API', async () => {
    mockUpload.mockResolvedValue({ status: 201, headers: {}, bodyBase64: 'e30=' });
    const body = { uri: 'file:///tmp/large.mov' } as unknown as BodyInit;

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/upload',
      { method: 'POST', body },
    );

    expect(response.status).toBe(201);
    expect(mockUpload).toHaveBeenCalledWith(
      expect.any(String),
      'https://192.0.2.1/upload',
      'POST',
      {},
      'file:///tmp/large.mov',
      `sha256-${'a'.repeat(43)}`,
      0,
    );
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('cancels the native request when the fetch signal aborts', async () => {
    mockRequest.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = createPinnedFetch(`sha256-${'a'.repeat(43)}`)('https://192.0.2.1/status', {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    expect(mockCancelRequest).toHaveBeenCalledWith(expect.any(String));
    void pending.catch(() => undefined);
  });

  it('sends a normal request through the shared remote proxy while retaining its pin', async () => {
    mockRemotePort.mockResolvedValue(4_321);
    mockRequest.mockResolvedValue({ status: 200, headers: {}, bodyBase64: 'e30=' });

    await createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://192.0.2.1/status');

    expect(mockRemotePort).toHaveBeenCalledWith('https://192.0.2.1/status', true);
    expect(mockRequest).toHaveBeenCalledWith(
      expect.any(String),
      'https://192.0.2.1/status',
      'GET',
      {},
      null,
      `sha256-${'a'.repeat(43)}`,
      4_321,
    );
  });

  it('retries a failed remote read directly with the same paired pin', async () => {
    const pin = `sha256-${'a'.repeat(43)}`;
    mockRemotePort.mockResolvedValue(4_321);
    mockRequest
      .mockRejectedValueOnce(new Error('Pinned TLS transport failed'))
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyBase64: 'e30=' });

    await expect(
      createPinnedFetch(pin, true)('https://verity.example/sessions'),
    ).resolves.toMatchObject({
      status: 200,
    });
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      'https://verity.example/sessions',
      'GET',
      {},
      null,
      pin,
      0,
    );
    expect(mockRequest.mock.calls[1]?.[0]).toBe(mockRequest.mock.calls[0]?.[0]);
    expect(mockReportDirectSuccess).toHaveBeenCalledWith('https://verity.example/sessions');
  });

  it('retries a TLS-stalled remote read through a recovered tunnel', async () => {
    const pin = `sha256-${'a'.repeat(43)}`;
    mockRemotePort.mockResolvedValue(4_321);
    mockRecoverRemoteRead.mockResolvedValue(true);
    mockRequest
      .mockRejectedValueOnce(new Error('Pinned TLS transport failed [NO_AUTH_CHALLENGE]'))
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyBase64: 'e30=' });

    await expect(
      createPinnedFetch(pin, true)('https://verity.example/sessions'),
    ).resolves.toMatchObject({ status: 200 });
    expect(mockRecoverRemoteRead).toHaveBeenCalledWith('https://verity.example/sessions', 4_321);
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      mockRequest.mock.calls[0]?.[0],
      'https://verity.example/sessions',
      'GET',
      {},
      null,
      pin,
      4_321,
    );
    expect(mockReportDirectSuccess).not.toHaveBeenCalled();
  });

  it('does not retry a remote read cancelled during proxy recovery', async () => {
    const controller = new AbortController();
    let finishRecovery!: (recovered: boolean) => void;
    mockRemotePort.mockResolvedValue(4_321);
    mockRequest.mockRejectedValueOnce(new Error('Pinned TLS transport failed [NO_AUTH_CHALLENGE]'));
    mockRecoverRemoteRead.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finishRecovery = resolve;
      }),
    );
    const pending = createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)(
      'https://verity.example/sessions',
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRecoverRemoteRead).toHaveBeenCalledTimes(1);
    controller.abort();
    finishRecovery(true);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('recovers a read that the untested direct route lost through Uplink', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
    const pin = `sha256-${'a'.repeat(43)}`;
    mockRemotePort.mockResolvedValueOnce(0).mockResolvedValueOnce(4_321);
    mockRequest
      .mockRejectedValueOnce(new Error('Pinned TLS transport failed [NSURLErrorDomain:-1003]'))
      .mockResolvedValueOnce({ status: 200, headers: {}, bodyBase64: 'e30=' });

    await expect(
      createPinnedFetch(pin, true)('https://verity.example/sessions'),
    ).resolves.toMatchObject({ status: 200 });
    // Without the recovery the first read after leaving the VPN fails on screen
    // and only its retry reaches Uplink.
    expect(mockReportDirectFailure).toHaveBeenCalledWith('https://verity.example/sessions');
    expect(mockRequest).toHaveBeenNthCalledWith(
      2,
      mockRequest.mock.calls[0]?.[0],
      'https://verity.example/sessions',
      'GET',
      {},
      null,
      pin,
      4_321,
    );
    expect(mockReportDirectSuccess).not.toHaveBeenCalled();
  });

  it('reports both routes when the Uplink recovery of a direct read also fails', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
    mockRemotePort.mockResolvedValueOnce(0).mockResolvedValueOnce(4_321);
    mockRequest.mockRejectedValue(
      new Error('Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]'),
    );

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      name: 'VerityConnectionError',
      message:
        'Direct and Uplink Core requests failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]; Uplink: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['dead', 0],
    // A probe timeout is not a verdict; the read gets a bounded grace period.
    ['unknown', 4_000],
  ])('cancels a stalled direct read once the route probe says %s', async (outcome, delayMs) => {
    jest.useFakeTimers();
    try {
      const pin = `sha256-${'a'.repeat(43)}`;
      let resolveVerdict!: (verdict: string) => void;
      mockDirectVerdict.mockReturnValue(
        new Promise<string>((resolve) => {
          resolveVerdict = resolve;
        }),
      );
      let failDirect!: (error: Error) => void;
      mockRequest
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              failDirect = reject;
            }),
        )
        .mockResolvedValueOnce({ status: 200, headers: {}, bodyBase64: 'e30=' });
      mockCancelRequest.mockImplementation(async () => {
        failDirect(new Error('Pinned TLS transport failed [NSURLErrorDomain:-999]'));
      });
      mockRemotePort.mockResolvedValueOnce(0).mockResolvedValueOnce(4_321);

      const pending = createPinnedFetch(pin, true)('https://verity.example/sessions');
      await jest.advanceTimersByTimeAsync(0);
      // Off the VPN a blackholed private address would otherwise hold this read
      // for the whole request timeout before Uplink gets its turn.
      resolveVerdict(outcome);
      await jest.advanceTimersByTimeAsync(Math.max(0, delayMs - 1));
      expect(mockCancelRequest).toHaveBeenCalledTimes(delayMs === 0 ? 1 : 0);
      await jest.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(mockCancelRequest).toHaveBeenCalledWith(mockRequest.mock.calls[0]?.[0]);
      expect(mockRequest).toHaveBeenNthCalledWith(
        2,
        mockRequest.mock.calls[0]?.[0],
        'https://verity.example/sessions',
        'GET',
        {},
        null,
        pin,
        4_321,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces an abort that arrives during the Uplink recovery request', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
    const controller = new AbortController();
    mockRemotePort.mockResolvedValueOnce(0).mockResolvedValueOnce(4_321);
    mockRequest
      .mockRejectedValueOnce(new Error('Pinned TLS transport failed [NSURLErrorDomain:-1003]'))
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error('private native text');
      });

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('surfaces an abort that arrives while Uplink admission runs', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
    const controller = new AbortController();
    mockRemotePort.mockResolvedValueOnce(0).mockImplementationOnce(async () => {
      controller.abort();
      return 4_321;
    });
    mockRequest.mockRejectedValue(
      new Error('Pinned TLS transport failed [NSURLErrorDomain:-1003]'),
    );

    // A cancelled read must not come back as a connection error on screen.
    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions', {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('reports the direct failure when Uplink admission itself rejects', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
    mockRemotePort.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('admission crashed'));
    mockRequest.mockRejectedValue(
      new Error('Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]'),
    );

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      name: 'VerityConnectionError',
      message:
        'Direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    });
  });

  it('fails a read the known-good direct route lost without an Uplink detour', async () => {
    mockRemotePort.mockResolvedValue(0);
    mockRequest.mockRejectedValue(
      new Error('Pinned TLS transport failed [NSURLErrorDomain:-1004:NO_AUTH_CHALLENGE]'),
    );

    // A Core restart on a reachable route must surface at once, not after a
    // full admission, attachment and probe.
    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      name: 'VerityConnectionError',
      message:
        'Direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1004:NO_AUTH_CHALLENGE]',
    });
    expect(mockRemotePort).toHaveBeenCalledTimes(1);
    expect(mockReportDirectFailure).toHaveBeenCalledWith('https://verity.example/sessions');
  });

  it('names the unanswered address when the grace period ends without recovery', async () => {
    jest.useFakeTimers();
    try {
      mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
      let failDirect!: (error: Error) => void;
      mockRequest.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failDirect = reject;
          }),
      );
      mockCancelRequest.mockImplementation(async () => {
        failDirect(
          new Error('Pinned TLS transport failed [NSURLErrorDomain:-999:NO_AUTH_CHALLENGE]'),
        );
      });
      mockRemotePort.mockResolvedValue(0);
      mockRemoteFailure.mockReturnValue('probe');
      const pending = createPinnedFetch(
        `sha256-${'a'.repeat(43)}`,
        true,
      )('https://verity.example/sessions');
      const outcome = pending.catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(4_000);
      // The -999 is the app's own doing and tells the user nothing.
      expect(await outcome).toMatchObject({
        name: 'VerityConnectionError',
        message:
          'Uplink probe and direct Core request failed: paired address unanswered after the route probe timed out',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a slow direct read when another read proves the route reachable', async () => {
    jest.useFakeTimers();
    try {
      mockDirectVerdict.mockReturnValue(Promise.resolve('unknown'));
      mockRemotePort.mockResolvedValue(0);
      let finishSlow!: (response: { status: number; headers: {}; bodyBase64: string }) => void;
      mockRequest
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSlow = resolve;
            }),
        )
        .mockResolvedValueOnce({ status: 200, headers: {}, bodyBase64: 'e30=' });
      mockReportDirectSuccess.mockImplementation(() => {
        mockDirectKnownReachable.mockReturnValue(true);
      });
      const fetch = createPinnedFetch(`sha256-${'a'.repeat(43)}`, true);
      const slow = fetch('https://verity.example/slow');
      await jest.advanceTimersByTimeAsync(0);
      await expect(fetch('https://verity.example/fast')).resolves.toMatchObject({ status: 200 });
      await jest.advanceTimersByTimeAsync(4_000);
      expect(mockCancelRequest).not.toHaveBeenCalled();
      finishSlow({ status: 200, headers: {}, bodyBase64: 'e30=' });
      await expect(slow).resolves.toMatchObject({ status: 200 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports the probe refusal for a read it cancelled', async () => {
    mockDirectVerdict.mockReturnValue(Promise.resolve('dead'));
    mockDirectRefusal.mockReturnValue(
      'Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    );
    let failDirect!: (error: Error) => void;
    mockRequest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failDirect = reject;
        }),
    );
    mockCancelRequest.mockImplementation(async () => {
      failDirect(
        new Error('Pinned TLS transport failed [NSURLErrorDomain:-999:NO_AUTH_CHALLENGE]'),
      );
    });
    mockRemotePort.mockResolvedValue(0);
    mockRemoteFailure.mockReturnValue('admission (Remote admission failed: unavailable.)');

    // The cancellation is the app's own doing; the screen must name the refusal.
    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      message:
        'Uplink admission (Remote admission failed: unavailable.) and direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    });
  });

  it('never replays a failed direct mutation through Uplink', async () => {
    mockRemotePort.mockResolvedValue(0);
    mockRequest.mockRejectedValue(new Error('Pinned TLS transport failed'));

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ name: 'VerityConnectionError' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // A mutation asks for a route it can commit to, not one it may have to replay.
    expect(mockRemotePort.mock.calls).toEqual([['https://verity.example/sessions', false]]);
    expect(mockReportDirectFailure).toHaveBeenCalledWith('https://verity.example/sessions');
  });

  it('restores direct reachability even when Core returns an HTTP error', async () => {
    mockRemotePort.mockResolvedValue(0);
    mockRequest.mockResolvedValue({ status: 503, headers: {}, bodyBase64: 'e30=' });
    await createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions');
    expect(mockReportDirectSuccess).toHaveBeenCalledWith('https://verity.example/sessions');
    expect(mockReportDirectFailure).not.toHaveBeenCalled();
  });

  it('does not classify a successful remote response as direct reachability', async () => {
    mockRemotePort.mockResolvedValue(4321);
    mockRequest.mockResolvedValue({ status: 200, headers: {}, bodyBase64: 'e30=' });
    await createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions');
    expect(mockReportDirectSuccess).not.toHaveBeenCalled();
  });

  it('never replays a failed remote mutation on the direct route', async () => {
    mockRemotePort.mockResolvedValue(4_321);
    mockRequest.mockRejectedValue(new Error('Pinned TLS transport failed'));

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toMatchObject({ name: 'VerityConnectionError' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    // The direct route was never tried, so nothing is known about it.
    expect(mockReportDirectFailure).not.toHaveBeenCalled();
  });

  it('cancels the direct retry when its fetch signal aborts', async () => {
    mockRemotePort.mockResolvedValue(4_321);
    let rejectDirect: ((error: Error) => void) | undefined;
    mockRequest
      .mockRejectedValueOnce(new Error('Pinned TLS transport failed'))
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectDirect = reject;
          }),
      );
    mockCancelRequest.mockImplementation(() => {
      rejectDirect?.(new Error('Cancelled'));
      return Promise.resolve();
    });
    const controller = new AbortController();
    const pending = createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)(
      'https://verity.example/sessions',
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRequest).toHaveBeenCalledTimes(2);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockCancelRequest).toHaveBeenCalledWith(mockRequest.mock.calls[1]?.[0]);
  });

  it('reports both failed routes when a remote read cannot recover directly', async () => {
    mockRemotePort.mockResolvedValue(4_321);
    mockRequest.mockRejectedValue(
      new Error(
        'Pinned TLS transport failed [NSURLErrorDomain:-1004:PIN_AND_CHAIN_TRUST_ACCEPTED]',
      ),
    );

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      name: 'VerityConnectionError',
      message:
        'Uplink and direct Core requests failed: Pinned TLS transport failed [NSURLErrorDomain:-1004:PIN_AND_CHAIN_TRUST_ACCEPTED]',
    });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockReportDirectFailure).toHaveBeenCalledWith('https://verity.example/sessions');
  });

  it('reports which route failed when the tunnel and direct Core request both fail', async () => {
    mockRemotePort.mockResolvedValue(0);
    mockRemoteFailure.mockReturnValue('probe');
    mockRequest.mockRejectedValue(
      new Error(
        'Call rejected: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE].',
      ),
    );

    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`, true)('https://verity.example/sessions'),
    ).rejects.toMatchObject({
      name: 'VerityConnectionError',
      message:
        'Uplink probe and direct Core request failed: Pinned TLS transport failed [NSURLErrorDomain:-1003:NO_AUTH_CHALLENGE]',
    });
    // Without this the next request is routed directly again, into the same
    // dead address, instead of through Uplink.
    expect(mockReportDirectFailure).toHaveBeenCalledWith('https://verity.example/sessions');
  });

  it('uses native UTF-8 text without decoding or transferring a Base64 body', async () => {
    mockRequestV2Enabled = true;
    const json = JSON.stringify({ title: 'Plötzlich größer 🚀' });
    mockRequestV2.mockResolvedValue({
      status: 200,
      headers: { 'Content-Type': 'application/problem+json' },
      bodyText: json,
    });
    const decode = jest.spyOn(globalThis, 'atob').mockImplementation(() => {
      throw new Error('Text response must not decode Base64');
    });
    try {
      const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
        'https://192.0.2.1/sessions',
      );
      expect(response.body).toBe(json);
      expect(mockRequestV2).toHaveBeenCalledTimes(1);
      expect(mockRequest).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it.each(['\uFEFFtext', '\uFEFF\uFEFFtext'])(
    'matches TextDecoder BOM semantics for native text %j',
    async (text) => {
      mockRequestV2Enabled = true;
      mockRequestV2.mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        bodyText: text,
      });
      const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
        'https://192.0.2.1/text',
      );
      expect(response.body).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    },
  );

  it('keeps binary bytes when the V2 endpoint returns Base64', async () => {
    mockRequestV2Enabled = true;
    mockRequestV2.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      bodyBase64: 'AP+A',
    });
    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/download',
    );
    const body = (response as unknown as { body: BodyInit }).body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([0, 255, 128]);
  });

  it.each([204, 205, 304])('ignores a native text body for bodyless status %s', async (status) => {
    mockRequestV2Enabled = true;
    mockRequestV2.mockResolvedValue({ status, headers: {}, bodyText: 'ignored' });
    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/status',
    );
    expect(response.body).toBeNull();
  });

  it('does not replay a failed V2 mutation through the legacy endpoint', async () => {
    mockRequestV2Enabled = true;
    mockRequestV2.mockRejectedValue(new Error('native transport error'));
    await expect(
      createPinnedFetch(`sha256-${'a'.repeat(43)}`)('https://192.0.2.1/turn', {
        method: 'POST',
        body: 'prompt',
      }),
    ).rejects.toThrow();
    expect(mockRequestV2).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it.each([204, 205, 304])('constructs a bodyless response for status %s', async (status) => {
    mockRequest.mockResolvedValue({ status, headers: {}, bodyBase64: '' });

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/status',
    );

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('decodes JSON response bytes as UTF-8 before constructing the response', async () => {
    const json = JSON.stringify({ title: 'Plötzlich größer' });
    mockRequest.mockResolvedValue({
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      bodyBase64: Buffer.from(json, 'utf8').toString('base64'),
    });

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/sessions',
    );

    expect(response.body).toBe(json);
  });

  it('keeps binary response bytes as an ArrayBuffer', async () => {
    mockRequest.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      bodyBase64: 'AP+A',
    });

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/download',
    );

    const body = (response as unknown as { body: BodyInit }).body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(body as ArrayBuffer)]).toEqual([0, 255, 128]);
  });

  it('replaces malformed bytes in a textual response like standard fetch', async () => {
    mockRequest.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      bodyBase64: 'Z3LDvM8=',
    });

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)('https://192.0.2.1/text');

    expect(response.body).toBe('grü�');
  });

  it('streams a pinned download directly into its destination', async () => {
    mockDownload.mockResolvedValue({ status: 200, uri: 'file:///cache/result.pdf' });
    await expect(
      downloadPinnedFile({
        url: 'https://192.0.2.1/file',
        destination: 'file:///cache/result.pdf',
        tlsPin: `sha256-${'b'.repeat(43)}`,
      }),
    ).resolves.toBe('file:///cache/result.pdf');
  });

  it('rejects an unsuccessful native download', async () => {
    mockDownload.mockResolvedValue({ status: 401, uri: 'file:///cache/result.pdf' });
    await expect(
      downloadPinnedFile({
        url: 'https://192.0.2.1/file',
        destination: 'file:///cache/result.pdf',
        tlsPin: `sha256-${'b'.repeat(43)}`,
      }),
    ).rejects.toThrow('status 401');
  });
});
