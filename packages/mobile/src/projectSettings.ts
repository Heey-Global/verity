// Pure helpers for the per-project Settings section (app/project/[id].tsx). Kept
// here — next to the Verity client + `ProjectSettings` — so the non-trivial rules
// (draft→patch omit-empty-Doppler / include-non-empty, dirty tracking, the
// configured count) are unit-tested by the existing vitest run without pulling in
// React Native. The screen is a thin consumer of these; it never re-implements the
// rules below. Mirrors the sibling `secretSettings.ts` for the global screen.
import type { ProjectSettings, ProjectSettingsPatch } from './api.js';

/** The editable form state the project-settings section binds to. `dopplerToken`
 *  is a write-only paste box: never populated from server state, and an empty box
 *  must never overwrite an already-configured token. The rest round-trip via
 *  GET/PATCH — a blank field clears the stored value. */
export type ProjectSettingsDraft = {
  defaultBranch: string;
  defaultModel: string;
  /** Operator-curated agent memory (ADR 0008). A round-trip field (blank clears
   *  it), but a free-text notes area — deliberately not part of the editable
   *  configuration count. Dev Server configuration lives in its own CRUD model. */
  memory: string;
};

/** The plain (non-secret) draft keys, each round-tripping through GET/PATCH. The
 *  write-only `dopplerToken` is handled separately (never echoed back). */
const ROUND_TRIP_KEYS = ['defaultBranch', 'defaultModel'] as const satisfies ReadonlyArray<
  keyof ProjectSettings & keyof ProjectSettingsDraft
>;

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Seed a fresh draft from the server's public settings. The Doppler box always
 *  starts empty (write-only); the plain fields load their stored value or ''. */
export function projectSettingsDraft(settings: ProjectSettings | null): ProjectSettingsDraft {
  return {
    defaultBranch: settings?.defaultBranch ?? '',
    defaultModel: settings?.defaultModel ?? '',
    memory: settings?.memory ?? '',
  };
}

/**
 * Build the PATCH body from the current draft.
 *
 * - The round-trip fields are ALWAYS included (trimmed → `null` when blank) so
 *   clearing a field persists.
 * - The write-only `dopplerToken` is included ONLY when the paste box is
 *   non-empty — an empty box must never overwrite an already-configured token
 *   with `null` (the server treats a present `dopplerToken` as a write).
 */
export function projectSettingsPatchFromDraft(draft: ProjectSettingsDraft): ProjectSettingsPatch {
  const patch: ProjectSettingsPatch = {
    defaultBranch: trimOrNull(draft.defaultBranch),
    defaultModel: trimOrNull(draft.defaultModel),
    memory: trimOrNull(draft.memory),
  };
  return patch;
}

/** True when the draft has no pending change: every round-trip field equals its
 *  stored value AND the write-only Doppler box is empty (a typed token is always
 *  a pending change). Inverse of the screen's `dirty`. */
export function sameProjectSettingsDraft(
  settings: ProjectSettings | null,
  draft: ProjectSettingsDraft,
): boolean {
  // Memory round-trips like the config fields (blank clears it) but lives outside
  // ROUND_TRIP_KEYS so it doesn't inflate the configured count — compare it here.
  if (trimOrNull(draft.memory) !== (settings?.memory ?? null)) return false;
  return ROUND_TRIP_KEYS.every((key) => trimOrNull(draft[key]) === (settings?.[key] ?? null));
}

/** How many editable round-trip settings are configured. */
export function configuredProjectSettingsCount(
  _settings: ProjectSettings | null,
  draft: ProjectSettingsDraft,
): number {
  const rest = ROUND_TRIP_KEYS.filter((key) => trimOrNull(draft[key]) !== null).length;
  return rest;
}
