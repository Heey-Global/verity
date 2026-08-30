// Pure onboarding-wizard flow model (#320, PR 1: shell). Kept here next to the
// Verity client so the ordered step list + the resume/progress logic are
// unit-tested by the vitest run without pulling in React Native. The wizard
// screens under apps/mobile are thin consumers of these helpers; they never
// re-derive the ordering or the resume target.
import type { OnboardingStatus } from './api.js';

/** Every screen id in the setup wizard, in presentation order. The device-local
 *  welcome and server connection screens are preflight: only after the app reaches
 *  a Verity server can it know whether to unlock an existing install or start this
 *  setup wizard. */
export type StepId =
  'master-password' | 'github' | 'doppler' | 'ai-backends' | 'first-project' | 'done';

export interface OnboardingStepDef {
  id: StepId;
  /** Human-facing title shown in the wizard header + progress ("Step N of M"). */
  title: string;
  /** Whether the step gates completion. Optional steps (Doppler) never block
   *  `complete` server-side and can be skipped in the wizard. The bookends
   *  (`welcome`/`done`) are non-blocking scaffolding, so also non-required. */
  required: boolean;
}

/**
 * The ordered setup wizard steps. Welcome + server URL entry are intentionally
 * not here; they are preflight screens before the app knows whether setup is
 * needed at all.
 */
export const ONBOARDING_STEPS: readonly OnboardingStepDef[] = [
  { id: 'master-password', title: 'Master password', required: true },
  { id: 'github', title: 'GitHub', required: true },
  { id: 'doppler', title: 'Doppler (optional)', required: false },
  { id: 'ai-backends', title: 'Agent logins (optional)', required: false },
  { id: 'first-project', title: 'First project', required: true },
  { id: 'done', title: 'All set', required: false },
] as const;

/** The step ids in order — handy for navigation without re-mapping the defs. */
export const ONBOARDING_STEP_IDS: readonly StepId[] = ONBOARDING_STEPS.map((s) => s.id);

/**
 * True when the server has no setup state yet. This is distinct from
 * resumeStep: after the operator has already passed the welcome/server-url
 * preflight, a pristine server resumes at master-password; on app launch, a
 * pristine server means a previously-saved URL now points at a reset server, so
 * the app should show the preflight welcome again instead of dropping into a
 * numbered setup step.
 */
export function isPristineOnboardingStatus(status: OnboardingStatus): boolean {
  return (
    !status.masterPasswordSet &&
    !status.githubAppConfigured &&
    !status.signingKeyConfigured &&
    !status.hasProject
  );
}

/**
 * Where to (re)enter the wizard for a given server status:
 *   - preflight routing handles missing server URLs before this helper runs.
 *   - `done` when setup is complete (nothing left to do),
 *   - the server's `nextStep` when some required step is still outstanding AND at
 *     least one step has been completed (resume mid-flow),
 *   - `welcome` on a pristine first run (nothing set yet) so the operator sees the
 *     intro before the first credential step.
 * Pure over its inputs — the gating hook and the wizard both call it.
 *
 */
export function resumeStep(status: OnboardingStatus): StepId {
  if (status.complete) return 'done';
  // Pristine: nothing configured at all → start at the first setup gate. Welcome
  // and server selection have already happened in preflight.
  if (isPristineOnboardingStatus(status)) return 'master-password';
  // Mid-flow: jump straight to the first incomplete required step. `nextStep` is
  // non-null here (not complete), but fall back defensively to `master-password`.
  return status.nextStep ?? 'master-password';
}

/**
 * Normalize a user-entered server address into a canonical base URL:
 *   - trims surrounding whitespace,
 *   - prepends `http://` when no scheme is present (LAN IP / Tailscale name typed
 *     bare — the common case; the operator can type `https://` explicitly),
 *   - keeps only the server origin so stored values never include `/api` or any
 *     other route prefix.
 * Returns `null` for an empty/whitespace-only input so callers can reject it.
 * Pure + framework-free so it is unit-tested in vitest and reused by the app's
 * `setVerityBaseUrl` (the single normalizer — the app never re-derives these rules).
 */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  // Bare host/IP defaults to HTTP; control-plane endpoints support only HTTP(S).
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin === 'null') {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Position of a step for the "Step N of M" indicator. `index` is 1-based over
 * {@link ONBOARDING_STEPS}; `total` is the step count. Throws on an unknown id so
 * a typo surfaces loudly rather than rendering "Step 0 of N".
 */
export function stepProgress(stepId: StepId): { index: number; total: number } {
  const zeroBased = ONBOARDING_STEP_IDS.indexOf(stepId);
  if (zeroBased === -1) {
    throw new Error(`unknown onboarding step: ${stepId}`);
  }
  return { index: zeroBased + 1, total: ONBOARDING_STEPS.length };
}
