import { Platform } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { AttachmentUpload } from '@verity/mobile';

/** Inspect only already-authorized photos; quick capture never prompts for library access. */
export async function recentTaskScreenshot(): Promise<{ uri: string; filename: string } | null> {
  if (Platform.OS === 'web') return null;
  try {
    // Older installed native builds can still capture without this optional module.
    const media = await import('expo-media-library');
    const permission = await media.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) return null;
    const assets = await new media.Query()
      .eq(media.AssetField.MEDIA_TYPE, media.MediaType.IMAGE)
      .gte(media.AssetField.CREATION_TIME, Date.now() - 120000)
      .orderBy({ key: media.AssetField.CREATION_TIME, ascending: false })
      .limit(10)
      .exe();
    for (const item of assets) {
      const asset = new media.Asset(item.id);
      const filename = await asset.getFilename();
      const screenshot =
        Platform.OS === 'ios'
          ? (await asset.getMediaSubtypes()).includes(media.MediaSubtype.SCREENSHOT)
          : /screenshot/i.test(filename);
      if (screenshot) return { uri: await asset.getUri(), filename };
    }
  } catch {
    /* Permission, native-module and cloud failures leave the picker available. */
  }
  return null;
}
export async function readTaskScreenshot(screenshot: {
  uri: string;
  filename: string;
}): Promise<AttachmentUpload[]> {
  const image = await manipulateAsync(screenshot.uri, [{ resize: { width: 1600 } }], {
    base64: true,
    compress: 0.8,
    format: SaveFormat.JPEG,
  });
  if (!image.base64) throw new Error('Could not read screenshot');
  return [{ kind: 'image', mediaType: 'image/jpeg', data: image.base64 }];
}

export async function enableTaskScreenshotSuggestions(): Promise<void> {
  const media = await import('expo-media-library');
  const permission = await media.requestPermissionsAsync(false, ['photo']);
  if (!permission.granted)
    throw new Error(
      'Photo-library access was not granted. You can still attach photos with the picker.',
    );
}

export type ScreenshotAccess = 'granted' | 'undetermined' | 'denied' | 'unavailable';

/** Whether quick capture may look for screenshots, without prompting. */
export async function screenshotAccess(): Promise<ScreenshotAccess> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    const media = await import('expo-media-library');
    const permission = await media.getPermissionsAsync(false, ['photo']);
    if (permission.granted) return 'granted';
    return permission.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** A small JPEG data URI of the screenshot. Library URIs (ph://) do not render
 *  in Image on every platform, so the suggestion shows this instead. */
export async function previewTaskScreenshot(screenshot: { uri: string }): Promise<string | null> {
  try {
    const image = await manipulateAsync(screenshot.uri, [{ resize: { width: 120 } }], {
      base64: true,
      compress: 0.7,
      format: SaveFormat.JPEG,
    });
    return image.base64 ? `data:image/jpeg;base64,${image.base64}` : null;
  } catch {
    return null;
  }
}
