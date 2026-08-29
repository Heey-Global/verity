export const CODEX_MODEL_PREFIX = 'codex/';
export const CODEX_DEFAULT_MODEL = `${CODEX_MODEL_PREFIX}default`;

export function isCodexModel(model: string | undefined): boolean {
  return model?.startsWith(CODEX_MODEL_PREFIX) === true;
}

/** Verity model ids are `codex/default` or `codex/<codex-model-id>`. */
export function parseCodexModel(model: string | undefined): string | undefined {
  if (model === undefined || model === CODEX_DEFAULT_MODEL) return undefined;
  if (!model.startsWith(CODEX_MODEL_PREFIX)) {
    throw new Error(`Codex model must start with "${CODEX_MODEL_PREFIX}"; got "${model}"`);
  }
  const id = model.slice(CODEX_MODEL_PREFIX.length);
  if (id.length === 0) throw new Error(`Codex model must not be empty; got "${model}"`);
  return id;
}
