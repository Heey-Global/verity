export function resolveProjectRelayImage(environment: NodeJS.ProcessEnv): string {
  const image =
    environment.VERITY_PROJECT_RELAY_IMAGE?.trim() ||
    environment.VERITY_BUNDLED_PROJECT_RELAY_IMAGE?.trim();
  if (image === undefined || image.length === 0) {
    throw new Error(
      'a bundled or VERITY_PROJECT_RELAY_IMAGE relay image is required and must be digest-pinned',
    );
  }
  return image;
}
