/** Project sessions accept subscription models and the configured OpenCode gateway. */
export function isProjectSessionModel(model: string): boolean {
  return (
    !model.includes('/') ||
    model.startsWith('codex/') ||
    (model.startsWith('verity/') && model.length > 'verity/'.length)
  );
}
