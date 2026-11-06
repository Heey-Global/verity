const mockDownloadFileAsync = jest.fn();
const mockDownloadPinned = jest.fn();
const mockShareAsync = jest.fn();
const mockProfile = { value: undefined as unknown };

jest.mock('expo-file-system', () => {
  class Directory {
    uri: string;
    constructor(...parts: string[]) {
      this.uri = parts.join('/');
    }
    create() {}
  }
  class File {
    uri: string;
    constructor(parent: { uri: string } | string, name?: string) {
      this.uri =
        typeof parent === 'string' && name === undefined
          ? parent
          : `${String((parent as { uri: string }).uri ?? parent)}/${name}`;
    }
    static downloadFileAsync = (...args: unknown[]) => mockDownloadFileAsync(...args);
  }
  return { Directory, File, Paths: { cache: 'file:///cache' } };
});
jest.mock('./authToken', () => ({ getAuthToken: () => 'secret-token' }));
jest.mock('./client', () => ({ getVerityBaseUrl: () => 'https://verity.test' }));
jest.mock('./serverProfile', () => ({ getServerProfile: () => mockProfile.value }));
jest.mock('./pinnedTransport', () => ({
  downloadPinnedFile: (input: unknown) => mockDownloadPinned(input),
}));
jest.mock('./sessionFileUi', () => ({
  loadSharingModule: async () => ({
    isAvailableAsync: async () => true,
    shareAsync: mockShareAsync,
  }),
}));

import { shareDownload } from './shareDownload';

const url = 'https://verity.test/knowledge/shared/files/download?path=sources%2Fa.pdf';

beforeEach(() => {
  jest.clearAllMocks();
  mockProfile.value = undefined;
  mockDownloadFileAsync.mockImplementation(async (_url: string, destination: { uri: string }) => ({
    uri: destination.uri,
  }));
});

// Reading the file through fetch first broke on iOS: React Native's Blob has no
// arrayBuffer(), and the screen showed "undefined is not a function".
it('downloads straight from the URL with the bearer and never reads a Blob', async () => {
  const webBlob = jest.fn();
  await shareDownload({ url, path: 'sources/a.pdf', cacheFolder: 'shared-knowledge', webBlob });
  expect(webBlob).not.toHaveBeenCalled();
  expect(mockDownloadFileAsync).toHaveBeenCalledWith(
    url,
    expect.objectContaining({ uri: 'file:///cache/shared-knowledge/a.pdf' }),
    { idempotent: true, headers: { authorization: 'Bearer secret-token' } },
  );
  expect(mockShareAsync).toHaveBeenCalledWith('file:///cache/shared-knowledge/a.pdf', {
    mimeType: 'application/pdf',
    dialogTitle: 'Open a.pdf',
  });
});

it('keeps the server’s TLS pin on a direct connection', async () => {
  mockProfile.value = {
    endpoints: [{ url: 'https://verity.test', transport: 'direct', tlsPin: 'sha256/pin' }],
  };
  mockDownloadPinned.mockResolvedValue('file:///cache/shared-knowledge/a.pdf');
  await shareDownload({
    url,
    path: 'sources/a.pdf',
    cacheFolder: 'shared-knowledge',
    webBlob: jest.fn(),
  });
  expect(mockDownloadFileAsync).not.toHaveBeenCalled();
  expect(mockDownloadPinned).toHaveBeenCalledWith(
    expect.objectContaining({
      url,
      tlsPin: 'sha256/pin',
      headers: { authorization: 'Bearer secret-token' },
    }),
  );
});
