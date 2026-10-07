import type { DroppedFileDescriptor } from './attachments';

/** Mirrors the native drop target's composer default (VerityDropZone.swift). */
export const DEFAULT_MAX_DROPPED_FILE_BYTES = 5_250_000;

export interface WebDropLimits {
  maxFiles: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface WebDroppedItem {
  file: File;
  isDirectory: boolean;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}

/** Apply the native drop target's limits to a browser drop. Accepted files are
 * exposed as object URLs that the reader releases after use. */
export function acceptWebDrop(
  items: readonly WebDroppedItem[],
  limits: WebDropLimits,
  createUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): { files: DroppedFileDescriptor[]; errors: string[] } {
  const maxFileBytes =
    limits.maxFileBytes && limits.maxFileBytes > 0
      ? limits.maxFileBytes
      : DEFAULT_MAX_DROPPED_FILE_BYTES;
  const maxTotalBytes = Math.max(0, limits.maxTotalBytes ?? 0);
  const supported = items.filter((item) => !item.isDirectory);
  const accepted = supported.slice(0, Math.max(0, limits.maxFiles));
  const errors: string[] = [];
  if (supported.length > accepted.length) {
    errors.push(
      `Only ${limits.maxFiles} more file${limits.maxFiles === 1 ? '' : 's'} can be added.`,
    );
  }
  if (supported.length < items.length) {
    errors.push('Folders and some file types are not supported.');
  }
  const files: DroppedFileDescriptor[] = [];
  let total = 0;
  for (const { file } of accepted) {
    const name = file.name || 'Dropped file';
    if (file.size > maxFileBytes) {
      errors.push(`"${name}" is too large (max ~${megabytes(maxFileBytes)} MB per file).`);
      continue;
    }
    if (maxTotalBytes > 0 && total + file.size > maxTotalBytes) {
      errors.push(`"${name}" was skipped (max ~${megabytes(maxTotalBytes)} MB per drop).`);
      continue;
    }
    total += file.size;
    files.push({
      uri: createUrl(file),
      fileName: name,
      mediaType: file.type || 'application/octet-stream',
    });
  }
  return { files, errors };
}

/** Read a browser DataTransfer into drop items; folders are flagged so they can be refused. */
export function webDroppedItems(transfer: DataTransfer): WebDroppedItem[] {
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0) {
    return Array.from(transfer.files).map((file) => ({ file, isDirectory: false }));
  }
  return items.flatMap((item) => {
    const file = item.getAsFile();
    if (!file) return [];
    return [{ file, isDirectory: item.webkitGetAsEntry?.()?.isDirectory === true }];
  });
}
