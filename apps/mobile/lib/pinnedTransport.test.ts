const mockRequest = jest.fn();
const mockUpload = jest.fn();
const mockDownload = jest.fn();
const mockCancelRequest = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({
    request: mockRequest,
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
    mockUpload.mockReset();
    mockDownload.mockReset();
    mockCancelRequest.mockReset();
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

  it.each([204, 205, 304])('constructs a bodyless response for status %s', async (status) => {
    mockRequest.mockResolvedValue({ status, headers: {}, bodyBase64: '' });

    const response = await createPinnedFetch(`sha256-${'a'.repeat(43)}`)(
      'https://192.0.2.1/status',
    );

    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
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
