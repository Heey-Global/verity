export type PublicPreviewTargetKind = 'dev-server' | 'static-folder';

export function canCreatePublicPreviewTarget(
  kind: PublicPreviewTargetKind,
  input: { devServerRunning: boolean; projectActive: boolean },
): boolean {
  return kind === 'static-folder' ? input.projectActive : input.devServerRunning;
}
