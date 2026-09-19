// Building a `PATCH /settings` body from what an operator actually edited.
//
// The settings surface is split across several screens (index, GitHub, services,
// MCP, maintenance), and `VeritySettingsPatch` is a partial: every key is
// optional, and an omitted key is left untouched server-side. That is the only
// thing keeping the split safe. A screen that sends its *whole* form — the way a
// single-screen editor can get away with — would send `null` for every field it
// happens to render blank, including the fields another screen owns. The GitHub
// screen would silently clear the transcription endpoint.
//
// `changedTextSettings` is therefore the single way a screen turns its draft into
// a patch: it emits a key ONLY when that key's trimmed draft value differs from
// what the server last reported, and it can only ever emit the keys the caller
// passed in. Screens never hand-assemble a patch object.
import type { VeritySettings, VeritySettingsPatch } from './api.js';

/** The plain-text settings an operator types into a form. All of them round-trip
 *  through GET/PATCH as `string | null`; write-only secret values are a separate
 *  concern and live in {@link secretPatchFromDraft}. */
export type VerityTextSettingKey =
  | 'gitUserName'
  | 'gitUserEmail'
  | 'gitSshPrivateKeyPath'
  | 'gitSshPublicKeyPath'
  | 'gitKnownHostsPath'
  | 'gitAllowedSignersPath'
  | 'githubAppId'
  | 'githubAppInstallationId'
  | 'transcribeBaseUrl'
  | 'transcribeModel'
  | 'opencodeBaseUrl';

/** A screen's text draft: the subset of {@link VerityTextSettingKey} it renders. */
export type VerityTextSettingsDraft = Partial<Record<VerityTextSettingKey, string>>;

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** What the server currently holds for `key`, normalised to the draft's shape.
 *  `opencode*` are optional on the record (older servers omit them), so an absent
 *  value has to read as "unset" rather than as a difference worth saving. */
export function storedTextSetting(
  settings: VeritySettings | null,
  key: VerityTextSettingKey,
): string | null {
  return settings?.[key] ?? null;
}

/** The draft value for `key` as it would be persisted (trimmed, blank → `null`). */
export function draftTextSetting(
  draft: VerityTextSettingsDraft,
  key: VerityTextSettingKey,
): string | null {
  const value = draft[key];
  return value === undefined ? null : trimOrNull(value);
}

/**
 * The patch for a draft: exactly the keys whose value changed, and nothing else.
 *
 * Keys the draft does not carry are never emitted — that is what lets one screen
 * save without touching another screen's fields. An empty result means there is
 * nothing to save and the caller should not issue a request at all.
 */
export function changedTextSettings(
  draft: VerityTextSettingsDraft,
  settings: VeritySettings | null,
): VeritySettingsPatch {
  const patch: VeritySettingsPatch = {};
  for (const key of Object.keys(draft) as VerityTextSettingKey[]) {
    const next = draftTextSetting(draft, key);
    if (next !== storedTextSetting(settings, key)) patch[key] = next;
  }
  return patch;
}

/** True when any key in `draft` differs from the stored settings. */
export function textSettingsDirty(
  draft: VerityTextSettingsDraft,
  settings: VeritySettings | null,
): boolean {
  return Object.keys(changedTextSettings(draft, settings)).length > 0;
}

/** The write-only credentials an operator pastes. Never read back from the
 *  server, so "unchanged" cannot be computed — a blank box means "keep what is
 *  stored", never "clear it". */
export type SecretPasteKey =
  | 'githubAppPrivateKey'
  | 'gitSshPrivateKey'
  | 'codexAuthJson'
  | 'opencodeApiKey'
  | 'dopplerServiceToken'
  | 'uplinkSubscriptionKey'
  | 'transcribeApiKey';

/** A screen's paste-box draft: the subset of {@link SecretPasteKey} it renders. */
export type SecretPasteDraft = Partial<Record<SecretPasteKey, string>>;

/**
 * The patch for pasted credentials: the declared boxes that hold something.
 *
 * `secretPatchFromDraft` is the wrong tool for a per-screen save even though it
 * looks like the right one. It ALWAYS emits `githubAppId` and
 * `githubAppInstallationId` — trimmed to `null` when blank — because it was
 * written for a single screen that rendered those two identifiers. A services
 * screen that reached for it would disconnect GitHub every time the operator
 * pasted a Doppler token, and nothing on screen would say so. This emits the
 * credentials and nothing else.
 */
export function changedSecretSettings(draft: SecretPasteDraft): VeritySettingsPatch {
  const patch: VeritySettingsPatch = {};
  for (const key of Object.keys(draft) as SecretPasteKey[]) {
    const value = draft[key]?.trim() ?? '';
    if (value.length > 0) patch[key] = value;
  }
  return patch;
}

/** Settings that only steer the app's own UI. They change nothing inside a
 *  project container, so saving one must not ask the operator to reprovision. */
const APP_ONLY_PATCH_KEYS = new Set<string>(['advancedModeEnabled', 'transcribeBackendMode']);

/**
 * Whether a saved patch still has to reach ALREADY RUNNING project containers.
 *
 * Everything else — git identity, signing material, every credential — is baked
 * into a container's environment when it is created, so an existing container
 * keeps the old value until it is recreated. Default-on for unknown keys: a new
 * setting that does need a reprovision must not slip through silently just
 * because nobody remembered to list it here.
 */
export function requiresContainerApply(patch: VeritySettingsPatch): boolean {
  return Object.keys(patch).some((key) => !APP_ONLY_PATCH_KEYS.has(key));
}
