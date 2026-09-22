// Attachment pickers shared by the two compose surfaces (new-session + chat box).
// Pure logic (no Unistyles StyleSheet), so it can live outside `app/` and be reused
// by both screens rather than duplicated. Each fn returns ready-to-send
// AttachmentUpload[] and THROWS an Error with a user-facing message on failure; the
// caller surfaces it via Alert.
import type { AttachmentUpload, MeetingTranscriptUpload } from '@verity/mobile';
import * as DocumentPicker from 'expo-document-picker';
import { File as FsFile } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/** An image upload's media type — the 4 types every vision backend accepts. */
type ImageUploadMediaType = Extract<AttachmentUpload, { kind: 'image' }>['mediaType'];

/** Base64 ceilings mirrored by the server. Images are recompressed and resized
 * into the vision-provider allowance; arbitrary files may contain 25 MB of bytes. */
const MAX_IMAGE_BASE64_LEN = 10_000_000;
const MAX_FILE_BYTES = 25_000_000;
const MAX_MEETING_AUDIO_FILE_NAME_LEN = 200;
const MAX_MEETING_AUDIO_TITLE_LEN = 120;

export interface DroppedFileDescriptor {
  uri: string;
  fileName: string;
  mediaType: string;
}

export interface PickedMeetingAudio {
  uri: string;
  fileName: string;
  mediaType: string;
  title: string;
}

export interface PickedSessionFile {
  uri: string;
  fileName: string;
}

function base64DecodedLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** A file that reads back as 0 bytes must never be attached: the server refuses
 * the whole turn over it, prompt and valid attachments included. On iPadOS the
 * usual cause is an iCloud Drive placeholder — the picker returns a URI for a
 * file whose contents were never downloaded, and reports no error for it — so
 * the message names the files and the one action that fixes them. */
function emptyAttachmentsMessage(fileNames: readonly string[]): string {
  const subject = fileNames.map((name) => `"${name}"`).join(', ');
  return fileNames.length === 1
    ? `${subject} is empty (0 bytes) and was not attached. If it lives in iCloud Drive, open it once in the Files app to download it, then attach it again.`
    : `${subject} are empty (0 bytes) and were not attached. If they live in iCloud Drive, open them once in the Files app to download them, then attach them again.`;
}

function truncateFileNamePreservingExtension(name: string, maxLength: number): string {
  if (name.length <= maxLength) return name;
  const extension = name.match(/(\.[^./\\]+)$/)?.[1] ?? '';
  if (extension.length >= maxLength) return name.slice(0, maxLength);
  return `${name.slice(0, maxLength - extension.length)}${extension}`;
}

/** Narrow the picker's reported image mime to a supported vision type; anything
 * else (or unknown) is treated as JPEG. The picker keeps a PNG/GIF/WEBP's format at
 * quality < 1, so we trust the asset's own type when it's one we support (a
 * mislabeled PNG is rejected by the vision API). */
function pickedImageMediaType(mimeType: string | undefined): ImageUploadMediaType {
  switch (mimeType) {
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return mimeType;
    default:
      return 'image/jpeg';
  }
}

/** Preserve vision-compatible image formats as image attachments; other image
 * formats and arbitrary documents remain normal file attachments. */
export function droppedImageMediaType(
  mimeType: string,
  fileName: string,
): ImageUploadMediaType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/gif') return 'image/gif';
  if (normalized === 'image/webp') return 'image/webp';
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  return null;
}

/** Read temporary files emitted by the native iOS drop target into uploads. */
export async function readDroppedAttachments(
  files: readonly DroppedFileDescriptor[],
  remaining: number,
): Promise<AttachmentUpload[]> {
  const uploads: AttachmentUpload[] = [];
  const empty: string[] = [];
  try {
    for (const [index, dropped] of files.entries()) {
      if (index >= remaining) continue;
      const file = new FsFile(dropped.uri);
      const data = await file.base64();
      if (data.length === 0) {
        empty.push(dropped.fileName);
        continue;
      }
      const imageType = droppedImageMediaType(dropped.mediaType, dropped.fileName);
      // A drop normally reports an honest UTType (`image/heic` → file attachment),
      // but a generic type falls back to the extension, so HEIF bytes carrying a
      // `.jpg` name would reach the vision backends mislabeled. Transcode those
      // like the picker path does — the native temporary copy still exists here.
      if (imageType && base64IsHeif(data)) {
        const converted = await jpegWithinImageLimit(dropped.uri, `"${dropped.fileName}"`);
        uploads.push({ kind: 'image', mediaType: 'image/jpeg', data: converted });
        continue;
      }
      if (imageType && data.length > MAX_IMAGE_BASE64_LEN) {
        const converted = await jpegWithinImageLimit(dropped.uri, `"${dropped.fileName}"`);
        uploads.push({ kind: 'image', mediaType: 'image/jpeg', data: converted });
        continue;
      }
      if (!imageType && base64DecodedLength(data) > MAX_FILE_BYTES) {
        throw new Error(`"${dropped.fileName}" is too large to attach (max 25 MB per file).`);
      }
      uploads.push(
        imageType
          ? { kind: 'image', mediaType: imageType, data }
          : {
              kind: 'file',
              mediaType: dropped.mediaType || 'application/octet-stream',
              fileName: dropped.fileName,
              data,
            },
      );
    }
    // Reported once for the whole drop, like the size limit above: a batch that
    // is partly unreadable is rejected as a batch rather than silently thinned.
    if (empty.length > 0) throw new Error(emptyAttachmentsMessage(empty));
    return uploads;
  } finally {
    // A failure on one item must not strand later native temporary copies.
    for (const dropped of files) {
      try {
        new FsFile(dropped.uri).delete();
      } catch {
        // Best effort; the OS also clears the app's temporary directory.
      }
    }
  }
}

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

/** `ftyp` box layout: 4 bytes size, `ftyp`, 4 bytes major brand, 4 bytes minor
 * version, then the compatible brands — 4 bytes each until the box ends. */
const FTYP_BRANDS_OFFSET = 16;
/** Upper bound for the decoded prefix. Real `ftyp` boxes list a handful of
 * brands, so this covers them while keeping the scan cheap on a 5 MB string. */
const MAX_FTYP_BOX_LEN = 256;

/** Read a big-endian uint32 from a latin1 string produced by {@link atob}. */
function readUint32(bytes: string, offset: number): number {
  return (
    bytes.charCodeAt(offset) * 0x1000000 +
    ((bytes.charCodeAt(offset + 1) << 16) |
      (bytes.charCodeAt(offset + 2) << 8) |
      bytes.charCodeAt(offset + 3))
  );
}

/** iOS may report HEIC bytes as `.jpg` / `image/jpeg`. Inspect the ISO-BMFF
 * `ftyp` brand instead of trusting that metadata, otherwise vision backends get
 * a JPEG-labelled payload they cannot decode. Encoders are free to put a generic
 * brand such as `isom` first and declare `heic` only among the compatible
 * brands, so the whole brand list is checked, not just the major brand. */
export function base64IsHeif(data: string): boolean {
  try {
    // 4 base64 chars decode to 3 bytes; keep the slice on a char-quadruple
    // boundary so a truncated prefix stays decodable.
    const prefix = data.slice(0, Math.ceil(MAX_FTYP_BOX_LEN / 3) * 4);
    const header = atob(prefix.slice(0, prefix.length - (prefix.length % 4)));
    if (header.slice(4, 8) !== 'ftyp') return false;
    if (HEIF_BRANDS.has(header.slice(8, 12))) return true;
    // Size 0 (box runs to EOF) or 1 (64-bit size follows) carries no usable
    // length here; scan whatever prefix was decoded in that case.
    const boxLen = readUint32(header, 0);
    const end = boxLen > 1 ? Math.min(boxLen, header.length) : header.length;
    for (let offset = FTYP_BRANDS_OFFSET; offset + 4 <= end; offset += 4) {
      if (HEIF_BRANDS.has(header.slice(offset, offset + 4))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Re-encode an image and progressively reduce its width until its base64 payload
 * fits. Starting each resize from the original avoids compounding JPEG artifacts. */
async function jpegWithinImageLimit(uri: string, subject: string): Promise<string> {
  let converted = await manipulateAsync(uri, [], {
    base64: true,
    compress: 0.7,
    format: SaveFormat.JPEG,
  });
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    if (typeof converted.base64 !== 'string') {
      throw new Error(`${subject} could not be converted to JPEG.`);
    }
    if (converted.base64.length <= MAX_IMAGE_BASE64_LEN) return converted.base64;
    if (attempt === 4 || !Number.isFinite(converted.width) || converted.width <= 1) break;
    const ratio = Math.sqrt(MAX_IMAGE_BASE64_LEN / converted.base64.length) * 0.9;
    const width = Math.max(1, Math.floor(converted.width * Math.min(ratio, 0.85)));
    converted = await manipulateAsync(uri, [{ resize: { width } }], {
      base64: true,
      compress: 0.7,
      format: SaveFormat.JPEG,
    });
  }
  throw new Error(`${subject} could not be reduced enough to attach.`);
}

/** Map picked assets to real vision-compatible bytes. Unsupported picker
 * formats — and mislabeled HEIF detected by signature — are transcoded rather
 * than merely renamed to JPEG. */
async function toImageUploads(
  assets: readonly ImagePicker.ImagePickerAsset[],
): Promise<AttachmentUpload[]> {
  const uploads: AttachmentUpload[] = [];
  for (const asset of assets) {
    // An empty payload is as unusable as a missing one — an iCloud-backed asset
    // the picker could not materialize reads back as an empty string, and the
    // callers turn "nothing usable" into a "could not be read" message.
    if (typeof asset.base64 !== 'string' || asset.base64.length === 0) continue;
    const reportedType = asset.mimeType;
    const supported =
      reportedType === 'image/jpeg' ||
      reportedType === 'image/png' ||
      reportedType === 'image/gif' ||
      reportedType === 'image/webp';
    if (!supported || base64IsHeif(asset.base64)) {
      const converted = await jpegWithinImageLimit(asset.uri, 'The selected image');
      uploads.push({ kind: 'image', mediaType: 'image/jpeg', data: converted });
      continue;
    }
    if (asset.base64.length > MAX_IMAGE_BASE64_LEN) {
      const converted = await jpegWithinImageLimit(asset.uri, 'The selected image');
      uploads.push({ kind: 'image', mediaType: 'image/jpeg', data: converted });
      continue;
    }
    uploads.push({
      kind: 'image',
      mediaType: pickedImageMediaType(reportedType),
      data: asset.base64,
    });
  }
  return uploads;
}

/** Pick one or more images from the library (PHPicker on iOS — no permission prompt). */
export async function pickImagesFromLibrary(remaining: number): Promise<AttachmentUpload[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    base64: true,
    quality: 0.7,
    allowsMultipleSelection: true,
    selectionLimit: remaining,
  });
  if (result.canceled) return [];
  const picked = await toImageUploads(result.assets);
  if (picked.length === 0) throw new Error('The selected image could not be read.');
  return picked;
}

/** Capture a photo with the camera (requests permission first). */
export async function captureImage(): Promise<AttachmentUpload[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Camera access is needed to take a photo. Enable it in Settings.');
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    base64: true,
    quality: 0.7,
  });
  if (result.canceled) return [];
  const picked = await toImageUploads(result.assets);
  if (picked.length === 0) throw new Error('The photo could not be read.');
  return picked;
}

/** Pick one or more arbitrary files (PDF, docs, …) and read their bytes as base64.
 * The bytes are delivered to the agent by materializing the file into its working
 * directory server-side (see {@link materializeFileAttachments}). */
export async function pickFiles(remaining: number): Promise<AttachmentUpload[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  const uploads: AttachmentUpload[] = [];
  const empty: string[] = [];
  for (const asset of result.assets.slice(0, remaining)) {
    const file = new FsFile(asset.uri);
    try {
      const data = await file.base64();
      if (data.length === 0) {
        empty.push(asset.name);
        continue;
      }
      if (base64DecodedLength(data) > MAX_FILE_BYTES) {
        throw new Error(`"${asset.name}" is too large to attach (max 25 MB per file).`);
      }
      uploads.push({
        kind: 'file',
        mediaType: asset.mimeType ?? 'application/octet-stream',
        fileName: asset.name,
        data,
      });
    } finally {
      try {
        file.delete();
      } catch {
        // Best-effort cleanup of the document picker's private cache copy.
      }
    }
  }
  // Collected across the selection so one alert names every unreadable file,
  // rather than the operator rediscovering them one re-pick at a time.
  if (empty.length > 0) throw new Error(emptyAttachmentsMessage(empty));
  return uploads;
}

/** Pick files for copying directly into the currently open session directory.
 * Keep only their temporary URIs so multiple large selections are not all held
 * in memory as base64 at once. */
export async function pickSessionFiles(): Promise<PickedSessionFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({ uri: asset.uri, fileName: asset.name }));
}

/** Pick a meeting audio file for server-side local transcription. The app only
 * uploads bytes; transcription and speaker diarization happen on Verity Server. */
export async function pickMeetingAudioAsset(): Promise<PickedMeetingAudio | null> {
  const result = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    type: ['audio/*'],
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  const fileName = truncateFileNamePreservingExtension(asset.name, MAX_MEETING_AUDIO_FILE_NAME_LEN);
  const title =
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .slice(0, MAX_MEETING_AUDIO_TITLE_LEN) || 'Meeting';
  return {
    uri: asset.uri,
    fileName,
    mediaType: asset.mimeType ?? 'audio/mpeg',
    title,
  };
}

export async function readMeetingAudioUpload(
  picked: PickedMeetingAudio,
): Promise<MeetingTranscriptUpload> {
  return {
    fileName: picked.fileName,
    mediaType: picked.mediaType,
    // expo/fetch streams this file-backed Blob instead of materializing a large
    // base64 string in JavaScript memory.
    data: new FsFile(picked.uri),
    title: picked.title,
  };
}

/** Pick a meeting audio file for server-side local transcription and read it as
 * a ready-to-upload payload. */
async function pickMeetingAudio(): Promise<MeetingTranscriptUpload | null> {
  const picked = await pickMeetingAudioAsset();
  return picked ? readMeetingAudioUpload(picked) : null;
}
