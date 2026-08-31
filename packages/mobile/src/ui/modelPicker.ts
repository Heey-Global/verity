/**
 * Ordering + default logic for the new-session model picker (ADR 0001 / #143). Kept
 * as a pure, headless helper (in the spirit of {@link parseBranchIssue} and the other
 * `ui/` units) so the list ordering and the chosen default are unit-testable without
 * a React/Expo harness - the screen (`apps/mobile/app/new.tsx`) just renders the
 * result.
 *
 * The routing contract is the model-string FORMAT (ADR 0001): a provider-qualified id
 * (`providerID/modelID`, contains `/`) routes to OpenCode; a `codex/...` id routes to
 * the Codex CLI backend; a bare id routes to Claude. The picker neither parses nor
 * rewrites the strings - it only orders them and picks a default - so whatever the
 * server returns flows through unchanged to `createSession`.
 */

/**
 * Order the picker's models alphabetically while de-duplicating. Pure - does not
 * mutate the input.
 */
export function orderModels(models: readonly string[]): string[] {
  return [...new Set(models)].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  );
}

/** Split a model list into the always-visible rows and a generic disclosure group.
 * Unknown/stale disclosure ids are ignored, and each model remains in exactly one group. */
export function partitionModels(
  models: readonly string[],
  moreModels: readonly string[],
  modelOrder: readonly string[] = models,
): { primary: string[]; more: string[] } {
  const available = new Set(models);
  const ordered = [
    ...new Set([...modelOrder.filter((model) => available.has(model)), ...orderModels(models)]),
  ];
  const nominatedMore = new Set(moreModels);
  const more = ordered.filter((model) => nominatedMore.has(model));
  const moreSet = new Set(more);
  return { primary: ordered.filter((model) => !moreSet.has(model)), more };
}

/**
 * The human-friendly display name for a model id, shared by every model/engine surface
 * (the new-session picker, the in-session switcher sheet, the composer chip, and the
 * home-list subtitle) so they read identically. Prettifies the three ADR-0001 id shapes:
 *
 *   - Codex CLI (`codex/…`): the operator thinks "Codex", not the raw slug, so
 *     `codex/default` (the CLI's own default) → `Codex`. A named codex model keeps its
 *     slug appended (`codex/gpt-5` → `Codex gpt-5`).
 *   - OpenCode (`providerID/modelID`, contains `/`): the trailing segment is already the
 *     product name, so keep it verbatim (`deepinfra/zai-org/GLM-5.2` → `GLM-5.2`).
 *   - Claude bare id: title-case the words and fuse the trailing numeric version parts
 *     with dots, dropping an 8-digit date stamp (`claude-opus-4-8` → `Claude Opus 4.8`,
 *     `claude-haiku-4-5-20251001` → `Claude Haiku 4.5`).
 *
 * `undefined` (no explicit model → the server's Claude default) reads as `Claude`.
 */
export function modelDisplayName(model: string | undefined): string {
  if (model === undefined || model === '') return 'Claude';
  if (model.startsWith('codex/')) {
    const slug = model.slice('codex/'.length);
    return slug === '' || slug === 'default' ? 'Codex' : `Codex ${slug}`;
  }
  if (model.includes('/')) return model.slice(model.lastIndexOf('/') + 1);
  return prettifyBareId(model);
}

/** Title-case a hyphenated bare id, fusing runs of numeric parts into a dotted version
 * and dropping a trailing 8-digit date stamp. See {@link modelDisplayName}. */
function prettifyBareId(id: string): string {
  const parts = id.split('-').filter(Boolean);
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1]!)) parts.pop();
  const out: string[] = [];
  let numbers: string[] = [];
  const flushNumbers = () => {
    if (numbers.length > 0) {
      out.push(numbers.join('.'));
      numbers = [];
    }
  };
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      numbers.push(part);
    } else {
      flushNumbers();
      out.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  flushNumbers();
  return out.join(' ') || id;
}

/**
 * The ENGINE behind a model id (ADR 0001 routing), used as the compact right-hand tag in
 * the switcher sheet: a `codex/…` id is Codex, any other provider-qualified id is
 * OpenCode, and a bare id (or `undefined` → the server default) is Claude.
 */
export function engineLabel(model: string | undefined): string {
  if (model === undefined) return 'Claude';
  if (model.startsWith('codex/')) return 'Codex';
  if (model.includes('/')) return 'OpenCode';
  return 'Claude';
}

/**
 * Resolve the picker's starting selection: the server's advertised `default` when it's
 * actually one of the offered `models`, else the first offered model, else `undefined`
 * (empty list - the picker shows nothing selectable and the spawn falls back to the
 * server's own default by sending no `model`). The server's default is a Claude id by
 * design (subscription-billed), so this normally yields a Claude model even though the
 * visible picker is alphabetical.
 */
export function defaultModel(
  models: readonly string[],
  serverDefault: string | undefined,
): string | undefined {
  if (serverDefault !== undefined && models.includes(serverDefault)) return serverDefault;
  return models[0];
}
