/** Older servers expose the local save target without a file-change signal. */
export function hasLocalSaveChanges(
  localMerge: { base: string; hasChanges?: boolean } | undefined,
): boolean {
  return localMerge !== undefined && localMerge.hasChanges !== false;
}
