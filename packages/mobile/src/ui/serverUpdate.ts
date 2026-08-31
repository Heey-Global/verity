import type { ServerUpdateOperation, ServerUpdateStatus } from '../api.js';

/**
 * The pure parts of the server self-update panel (ADR 0008 D4): what the panel
 * says, whether it may be acted on, and whether the app should keep polling.
 *
 * The server is replacing itself while this runs, so the panel has to stay
 * readable through a window where the API is unreachable. That is why the view
 * is derived from the last known operation rather than from request success:
 * a failed poll during activation means "still working", not "unknown".
 */

export interface ServerUpdateView {
  /** Panel headline. */
  readonly title: string;
  /** One sentence of context below the headline. */
  readonly detail: string;
  /** Label of the action button, or null when there is nothing to press. */
  readonly action: string | null;
  /** Digest the action would install; null whenever `action` is null. */
  readonly targetDigest: string | null;
  /** Idempotency key the action must send; null whenever `action` is null. */
  readonly idempotencyKey: string | null;
  /** `step` of `totalSteps` while an operation runs, else null. */
  readonly progress: { readonly step: number; readonly total: number } | null;
  /** True while the operation is still moving — the caller should keep polling. */
  readonly busy: boolean;
  /** True when the panel reports a problem rather than progress. */
  readonly failed: boolean;
}

const FAILURE_DETAIL: Record<string, string> = {
  'requested-failed': 'The update could not be started.',
  'pulling-failed': 'The new version could not be downloaded.',
  'verifying-image-failed': 'The new version failed signature verification.',
  'preflight-failed': 'The new version failed its readiness check.',
  'creating-standby-failed': 'The new version could not be prepared.',
};

const OPERATION_TITLE: Record<ServerUpdateOperation['state'], string> = {
  preparing: 'Preparing update',
  prepared: 'Update ready to activate',
  activating: 'Activating update',
  completed: 'Update installed',
  'rolling-back': 'Rolling back',
  'rolled-back': 'Update rolled back',
  failed: 'Update failed',
};

const OPERATION_DETAIL: Record<ServerUpdateOperation['state'], string> = {
  preparing: 'Downloading and verifying the new version. Verity stays available.',
  prepared: 'The new version passed verification and is waiting to take over.',
  activating: 'Switching over. Verity may be briefly unreachable.',
  completed: 'Verity is running the new version.',
  'rolling-back': 'Something went wrong during activation. Restoring the previous version.',
  'rolled-back': 'The previous version is running again. Nothing was lost.',
  failed: 'The update was stopped before anything changed.',
};

const BUSY_STATES: readonly ServerUpdateOperation['state'][] = [
  'preparing',
  'prepared',
  'activating',
  'rolling-back',
];

/** Operations the app should keep polling: they still move on their own. */
function isBusy(state: ServerUpdateOperation['state']): boolean {
  return BUSY_STATES.includes(state);
}

/** Terminal outcomes that did not install the new version. */
function isFailure(state: ServerUpdateOperation['state']): boolean {
  return state === 'failed' || state === 'rolled-back';
}

/**
 * Idempotency key for the install request.
 *
 * Pressing the button twice, or retrying after a dropped response, must rejoin
 * the same attempt rather than start a second update — the server answers a
 * repeated key straight from the journal. But that is exactly why the key
 * cannot be derived from the digest alone: after a failed attempt the journal
 * entry stays current until it is superseded, so a digest-only key would hand
 * back the old failure forever and the release could never be retried. Binding
 * the key to the generation of the last known operation keeps a retry-in-place
 * idempotent while making a retry-after-failure a genuinely new attempt.
 */
function attemptKey(targetDigest: string, operation: ServerUpdateOperation | null): string {
  return `app-${targetDigest.slice(-16)}-g${String(operation?.generation ?? 0)}`;
}

function describeOperation(operation: ServerUpdateOperation): ServerUpdateView {
  const failed = operation.state === 'failed';
  const detail =
    failed && operation.failureCode !== null
      ? (FAILURE_DETAIL[operation.failureCode] ?? OPERATION_DETAIL.failed)
      : OPERATION_DETAIL[operation.state];
  const busy = isBusy(operation.state);
  return {
    title: OPERATION_TITLE[operation.state],
    detail,
    action: null,
    targetDigest: null,
    idempotencyKey: null,
    progress: busy ? { step: operation.step, total: operation.totalSteps } : null,
    busy,
    failed: failed || operation.state === 'rolled-back',
  };
}

/**
 * Render the update panel. An in-flight operation always wins over the
 * availability state: while the server is updating itself, the release channel
 * still reports the OLD version as out of date, and offering "Install" again
 * there would invite a second, competing request.
 *
 * A finished-but-unsuccessful operation is different. It stays on screen so the
 * failure is not swallowed, but it must not be a dead end: as long as the
 * channel still reports a release, the panel keeps offering a way back.
 */
export function describeServerUpdate(status: ServerUpdateStatus): ServerUpdateView {
  const operation = status.operation;
  if (operation !== null && isBusy(operation.state)) return describeOperation(operation);
  if (operation !== null && isFailure(operation.state)) {
    const outcome = describeOperation(operation);
    if (status.state !== 'available') return outcome;
    const digest = status.release.serverImage;
    return {
      ...outcome,
      // A release published after the failure is a fresh install, not a retry.
      action: digest === operation.targetDigest ? 'Try again' : `Install ${status.release.version}`,
      targetDigest: digest,
      idempotencyKey: attemptKey(digest, operation),
    };
  }
  const idle = {
    action: null,
    targetDigest: null,
    idempotencyKey: null,
    progress: null,
    busy: false,
    failed: false,
  };
  switch (status.state) {
    case 'available':
      return {
        ...idle,
        title: `Version ${status.release.version} available`,
        detail: 'Verity can install this update itself and roll back if it does not come up.',
        action: `Install ${status.release.version}`,
        targetDigest: status.release.serverImage,
        idempotencyKey: attemptKey(status.release.serverImage, operation),
      };
    case 'current':
      return {
        ...idle,
        title: 'Verity is up to date',
        detail: `Running version ${status.release.version}.`,
      };
    case 'incompatible':
      return {
        ...idle,
        title: `Version ${status.release.version} cannot be installed`,
        // The reasons come from the compatibility check, not from free-form text.
        detail: status.reasons[0] ?? 'This release is not compatible with the current deployment.',
        failed: true,
      };
    case 'unreachable':
      return {
        ...idle,
        title: 'Update check unavailable',
        detail: 'Verity could not reach the release channel.',
      };
    case 'unsupported':
      return {
        ...idle,
        title: 'Updates are managed elsewhere',
        detail: 'This deployment was not installed by Verity, so it updates itself externally.',
      };
  }
}

/** Should the panel be shown at all? An unmanaged deployment has nothing to say. */
export function showsServerUpdatePanel(status: ServerUpdateStatus): boolean {
  return status.state !== 'unsupported' || status.operation !== null;
}

/**
 * Poll interval in milliseconds while an operation runs. Activation is the
 * window where the server disappears, so it is polled hardest; preparation can
 * take minutes of pulling and does not need the same cadence.
 */
export function serverUpdatePollMs(operation: ServerUpdateOperation | null): number | null {
  if (operation === null || !isBusy(operation.state)) return null;
  return operation.state === 'preparing' ? 5_000 : 2_000;
}

/**
 * Whether the app chrome should show that an update is waiting.
 *
 * Only `available`, and only while nothing is moving. An operation under way has
 * its own surface in settings — a dot that stayed lit through the update would
 * say "there is something to do" at the one moment there is not. `incompatible`
 * is excluded for the reason the notifier excludes it: pointing at an action the
 * API refuses is worse than saying nothing.
 *
 * A terminal operation is not a reason to stay dark, though, and reading any
 * operation as "busy" would have been a permanent silence: the Updater keeps the
 * last journal until the next request archives it, so a `failed` or
 * `rolled-back` attempt — the case where the operator most needs to be told the
 * release is still there — and an older `completed` one that a newer release has
 * since superseded would both have hidden the dot for good.
 */
export function serverUpdateAwaitsAttention(status: ServerUpdateStatus | undefined): boolean {
  if (status === undefined) return false;
  if (status.state !== 'available') return false;
  return status.operation === null || !isBusy(status.operation.state);
}
