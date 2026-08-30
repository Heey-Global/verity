const mockFileData = new Map<string, string>();
const mockReadErrors = new Set<string>();
const mockDelete = jest.fn<void, [string]>();
const mockManipulateAsync = jest.fn();
const mockLaunchImageLibraryAsync = jest.fn();
const mockLaunchCameraAsync = jest.fn();
const mockRequestCameraPermissionsAsync = jest.fn();
const mockGetDocumentAsync = jest.fn();

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: (...args: unknown[]) => mockGetDocumentAsync(...args),
}));

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation((uri: string) => ({
    base64: async () => {
      if (mockReadErrors.has(uri)) throw new Error('read failed');
      return mockFileData.get(uri) ?? '';
    },
    delete: () => mockDelete(uri),
  })),
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulateAsync(...args),
  SaveFormat: { JPEG: 'jpeg' },
}));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchImageLibraryAsync(...args),
  launchCameraAsync: (...args: unknown[]) => mockLaunchCameraAsync(...args),
  requestCameraPermissionsAsync: (...args: unknown[]) => mockRequestCameraPermissionsAsync(...args),
}));

import {
  base64IsHeif,
  captureImage,
  droppedImageMediaType,
  pickImagesFromLibrary,
  pickFiles,
  readDroppedAttachments,
} from './attachments';

describe('dragged attachments', () => {
  beforeEach(() => {
    mockFileData.clear();
    mockReadErrors.clear();
    mockDelete.mockClear();
    mockManipulateAsync.mockReset();
    mockLaunchImageLibraryAsync.mockReset();
    mockLaunchCameraAsync.mockReset();
    mockRequestCameraPermissionsAsync.mockReset();
    mockGetDocumentAsync.mockReset();
  });

  it('deletes document-picker cache copies after reading them', async () => {
    mockFileData.set('file:///cache/private.pdf', 'cGRm');
    mockGetDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [
        { uri: 'file:///cache/private.pdf', name: 'private.pdf', mimeType: 'application/pdf' },
      ],
    });

    await expect(pickFiles(1)).resolves.toEqual([
      {
        kind: 'file',
        mediaType: 'application/pdf',
        fileName: 'private.pdf',
        data: 'cGRm',
      },
    ]);
    expect(mockDelete).toHaveBeenCalledWith('file:///cache/private.pdf');
  });

  it('detects HEIF bytes even when iOS labels the asset as JPEG', () => {
    const header = Buffer.from('\0\0\0\u0018ftypheic\0\0\0\0').toString('base64');
    expect(base64IsHeif(header)).toBe(true);
    expect(base64IsHeif(Buffer.from('\u00ff\u00d8\u00ffjpeg').toString('base64'))).toBe(false);
  });

  it('detects HEIF declared only through a compatible brand', () => {
    // Major brand `isom`, compatible brands `isom` + `heic` — the shape some
    // encoders (and HEIF files converted from video containers) produce.
    const ftyp = (body: string, trailing = '') =>
      Buffer.from(`\0\0\0${String.fromCharCode(body.length + 8)}ftyp${body}${trailing}`).toString(
        'base64',
      );

    expect(base64IsHeif(ftyp('isom\0\0\0\0isomheic'))).toBe(true);
    expect(base64IsHeif(ftyp('isom\0\0\0\0isommif1'))).toBe(true);
    expect(base64IsHeif(ftyp('mp42\0\0\0\0mp42isom'))).toBe(false);
    // A HEIF brand past the end of the `ftyp` box belongs to a later box.
    expect(base64IsHeif(ftyp('isom\0\0\0\0', 'heic'))).toBe(false);
  });

  it('transcodes a JPEG-labelled HEIC library asset before upload', async () => {
    const heic = Buffer.from('\0\0\0\u0018ftypheic\0\0\0\0').toString('base64');
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///photo.jpg', mimeType: 'image/jpeg', base64: heic }],
    });
    mockManipulateAsync.mockResolvedValue({ uri: 'file:///converted.jpg', base64: 'anBlZw==' });

    await expect(pickImagesFromLibrary(1)).resolves.toEqual([
      { kind: 'image', mediaType: 'image/jpeg', data: 'anBlZw==' },
    ]);
    expect(mockManipulateAsync).toHaveBeenCalledWith(
      'file:///photo.jpg',
      [],
      expect.objectContaining({ base64: true, format: 'jpeg' }),
    );
  });

  it('transcodes an HEIC photo returned directly by the iPhone camera', async () => {
    const heic = Buffer.from('\0\0\0\u0018ftypheic\0\0\0\0').toString('base64');
    mockRequestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    mockLaunchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///camera-photo.jpg', mimeType: 'image/jpeg', base64: heic }],
    });
    mockManipulateAsync.mockResolvedValue({ uri: 'file:///converted.jpg', base64: 'anBlZw==' });

    await expect(captureImage()).resolves.toEqual([
      { kind: 'image', mediaType: 'image/jpeg', data: 'anBlZw==' },
    ]);
    expect(mockLaunchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({ base64: true, quality: 0.7 }),
    );
    expect(mockManipulateAsync).toHaveBeenCalledWith(
      'file:///camera-photo.jpg',
      [],
      expect.objectContaining({ base64: true, format: 'jpeg' }),
    );
  });

  it('keeps genuine PNG bytes without recompressing them', async () => {
    mockLaunchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///photo.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }],
    });

    await expect(pickImagesFromLibrary(1)).resolves.toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });

  it('recognizes vision-compatible images by MIME type or extension', () => {
    expect(droppedImageMediaType('image/png', 'capture')).toBe('image/png');
    expect(droppedImageMediaType('application/octet-stream', 'capture.JPEG')).toBe('image/jpeg');
    expect(droppedImageMediaType('image/heic', 'photo.heic')).toBeNull();
    expect(droppedImageMediaType('application/pdf', 'notes.pdf')).toBeNull();
  });

  it('transcodes dropped HEIF bytes that arrive under a JPEG extension', async () => {
    // Generic UTType, so droppedImageMediaType falls back to the `.jpg` name —
    // the bytes are HEIF (major brand `isom`, compatible brand `heic`).
    const heif = Buffer.from('\0\0\0\u0018ftypisom\0\0\0\0isomheic').toString('base64');
    mockFileData.set('file:///tmp/photo.jpg', heif);
    mockManipulateAsync.mockResolvedValue({ uri: 'file:///converted.jpg', base64: 'anBlZw==' });

    await expect(
      readDroppedAttachments(
        [
          {
            uri: 'file:///tmp/photo.jpg',
            fileName: 'photo.jpg',
            mediaType: 'application/octet-stream',
          },
        ],
        1,
      ),
    ).resolves.toEqual([{ kind: 'image', mediaType: 'image/jpeg', data: 'anBlZw==' }]);
    expect(mockManipulateAsync).toHaveBeenCalledWith(
      'file:///tmp/photo.jpg',
      [],
      expect.objectContaining({ base64: true, format: 'jpeg' }),
    );
    expect(mockDelete).toHaveBeenCalledWith('file:///tmp/photo.jpg');
  });

  it('keeps a dropped HEIC file as a plain file attachment', async () => {
    const heif = Buffer.from('\0\0\0\u0018ftypheic\0\0\0\0').toString('base64');
    mockFileData.set('file:///tmp/photo.heic', heif);

    await expect(
      readDroppedAttachments(
        [{ uri: 'file:///tmp/photo.heic', fileName: 'photo.heic', mediaType: 'image/heic' }],
        1,
      ),
    ).resolves.toEqual([
      { kind: 'file', mediaType: 'image/heic', fileName: 'photo.heic', data: heif },
    ]);
    expect(mockManipulateAsync).not.toHaveBeenCalled();
  });

  it('creates image and ordinary file uploads and removes temporary copies', async () => {
    mockFileData.set('file:///tmp/screenshot.png', 'cG5n');
    mockFileData.set('file:///tmp/notes.pdf', 'cGRm');

    await expect(
      readDroppedAttachments(
        [
          {
            uri: 'file:///tmp/screenshot.png',
            fileName: 'Screenshot.png',
            mediaType: 'image/png',
          },
          {
            uri: 'file:///tmp/notes.pdf',
            fileName: 'notes.pdf',
            mediaType: 'application/pdf',
          },
        ],
        2,
      ),
    ).resolves.toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'cG5n' },
      {
        kind: 'file',
        mediaType: 'application/pdf',
        fileName: 'notes.pdf',
        data: 'cGRm',
      },
    ]);
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('honors capacity and still removes ignored temporary copies', async () => {
    mockFileData.set('file:///tmp/one.png', 'b25l');
    mockFileData.set('file:///tmp/two.txt', 'dHdv');

    const uploads = await readDroppedAttachments(
      [
        { uri: 'file:///tmp/one.png', fileName: 'one.png', mediaType: 'image/png' },
        { uri: 'file:///tmp/two.txt', fileName: 'two.txt', mediaType: 'text/plain' },
      ],
      1,
    );

    expect(uploads).toHaveLength(1);
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('removes every temporary copy when reading one dropped file fails', async () => {
    mockReadErrors.add('file:///tmp/broken.pdf');
    mockFileData.set('file:///tmp/later.txt', 'bGF0ZXI=');

    await expect(
      readDroppedAttachments(
        [
          {
            uri: 'file:///tmp/broken.pdf',
            fileName: 'broken.pdf',
            mediaType: 'application/pdf',
          },
          {
            uri: 'file:///tmp/later.txt',
            fileName: 'later.txt',
            mediaType: 'text/plain',
          },
        ],
        2,
      ),
    ).rejects.toThrow('read failed');
    expect(mockDelete).toHaveBeenCalledWith('file:///tmp/broken.pdf');
    expect(mockDelete).toHaveBeenCalledWith('file:///tmp/later.txt');
  });

  it('removes the whole batch when one dropped file exceeds the JS safety limit', async () => {
    mockFileData.set('file:///tmp/oversize.pdf', 'x'.repeat(7_000_001));
    mockFileData.set('file:///tmp/later.txt', 'bGF0ZXI=');

    await expect(
      readDroppedAttachments(
        [
          {
            uri: 'file:///tmp/oversize.pdf',
            fileName: 'oversize.pdf',
            mediaType: 'application/pdf',
          },
          {
            uri: 'file:///tmp/later.txt',
            fileName: 'later.txt',
            mediaType: 'text/plain',
          },
        ],
        2,
      ),
    ).rejects.toThrow('too large to attach');
    expect(mockDelete).toHaveBeenCalledWith('file:///tmp/oversize.pdf');
    expect(mockDelete).toHaveBeenCalledWith('file:///tmp/later.txt');
  });
});
