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
  'host-runtime-failed':
    'The new version needs a Docker runtime this host does not have yet. Re-run the Verity installer on the host, then retry the update.',
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
  if (operation !== null && isBusy(operation.state)) {
    const outcome = describeOperation(operation);
    // The one exception to "in flight wins": the server reports the operation
    // stuck after commit and has said it will let a newer release replace it.
    if (status.recovery?.supersede !== true || status.state !== 'available') return outcome;
    const digest = status.release.serverImage;
    return {
      ...outcome,
      action: `Install ${status.release.version}`,
      targetDigest: digest,
      idempotencyKey: attemptKey(digest, operation),
    };
  }
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
  // A stuck operation a newer release may replace is exactly when the operator
  // has something to do, even though the operation is technically in flight.
  return (
    status.operation === null ||
    !isBusy(status.operation.state) ||
    status.recovery?.supersede === true
  );
}

// ── Panel model ──────────────────────────────────────────────────────────────

/** A card's action. Install forwards the server's own digest; retry names the
 *  operation, so a stale screen cannot act on a different one. */
export type ServerUpdateCardAction =
  | {
      readonly kind: 'install';
      readonly label: string;
      readonly targetDigest: string;
      readonly idempotencyKey: string;
      readonly primary: boolean;
    }
  | {
      readonly kind: 'retry';
      readonly label: string;
      readonly updateId: string;
      readonly primary: boolean;
    };

export interface ServerUpdateCard {
  readonly key: string;
  /** Section label above the card. */
  readonly section: string;
  readonly status: {
    readonly label: string;
    readonly tone: 'active' | 'problem' | 'done' | 'idle';
  };
  readonly title: string;
  /** Release the card is about, for the "Stable · released …" line; null when unknown. */
  readonly release: { readonly version: string; readonly publishedAt: string } | null;
  readonly detail: string;
  /** Running operation: where it is in its plan. */
  readonly progress: {
    readonly step: number;
    readonly total: number;
    readonly phase: string;
  } | null;
  /** Stuck operation: the phase it stopped in and since when (ISO). */
  readonly stalled: {
    readonly phase: string;
    readonly step: number;
    readonly total: number;
    readonly since: string;
  } | null;
  /** Closed-code explanation of the last failed attempt. */
  readonly error: string | null;
  readonly action: ServerUpdateCardAction | null;
  /** Release whose notes belong inside this card — only the version on offer. */
  readonly notesVersion: string | null;
}

export interface ServerUpdatePanel {
  /**
   * What is running now; null only for a server that reports neither. The
   * release date is known only when the channel's release is the running one,
   * and `upToDate` replaces a separate "up to date" card that would repeat it.
   */
  readonly installed: {
    readonly version: string;
    readonly publishedAt: string | null;
    readonly upToDate: boolean;
  } | null;
  readonly cards: readonly ServerUpdateCard[];
}

const PHASE_LABEL: Record<string, string> = {
  requested: 'Starting',
  pulling: 'Downloading',
  'verifying-image': 'Verifying',
  preflight: 'Readiness check',
  'creating-standby': 'Preparing',
  standby: 'Ready to switch',
  'quiescing-old': 'Switching over',
  'handing-off-key': 'Switching over',
  'activating-candidate': 'Switching over',
  'checking-candidate': 'Switching over',
  'draining-gateway': 'Switching over',
  'switching-gateway': 'Switching over',
  'observing-candidate': 'Switching over',
  committed: 'Updating companions',
  'reconciling-companions': 'Updating companions',
  'rollback-quiescing-candidate': 'Rolling back',
  'rollback-activating-old': 'Rolling back',
  'rollback-switching-gateway': 'Rolling back',
};

const CAUSE_LABEL: Record<string, string> = {
  'network-timeout': 'network timeout',
  network: 'network unreachable',
  registry: 'the registry refused the download',
  'disk-full': 'the disk is full',
  unhealthy: 'a service did not start',
  docker: 'Docker reported an error',
  unknown: 'unknown error',
};

/** Phases after which the stuck operation's target is already serving. */
const PROMOTED = ['committed', 'reconciling-companions'];

function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? 'Updating';
}

function attemptError(status: ServerUpdateStatus, operation: ServerUpdateOperation): string | null {
  const error = status.attempt?.updateId === operation.updateId ? status.attempt.lastError : null;
  if (error === null || error === undefined) return null;
  return `${phaseLabel(error.phase)} failed: ${CAUSE_LABEL[error.cause] ?? CAUSE_LABEL.unknown}`;
}

/** The version an operation is installing, when the payload lets us know it. */
function operationVersion(
  status: ServerUpdateStatus,
  operation: ServerUpdateOperation,
): { version: string; publishedAt: string } | null {
  if ('release' in status && status.release.serverImage === operation.targetDigest)
    return { version: status.release.version, publishedAt: status.release.publishedAt };
  // After commit the server runs the target, so its own version names it.
  if (PROMOTED.includes(operation.phase) && status.installed !== undefined)
    return { version: status.installed.version, publishedAt: '' };
  return null;
}

function availabilityCard(status: ServerUpdateStatus, key: string | null): ServerUpdateCard {
  const view = describeServerUpdate(status);
  const base = {
    key: 'availability',
    section: 'Update',
    release:
      'release' in status
        ? { version: status.release.version, publishedAt: status.release.publishedAt }
        : null,
    progress: null,
    stalled: null,
    error: null,
    notesVersion: null,
  };
  switch (status.state) {
    case 'available':
      return {
        ...base,
        status: { label: 'Available', tone: 'active' },
        title: view.title,
        detail: view.detail,
        action:
          view.targetDigest === null || key === null
            ? null
            : {
                kind: 'install',
                label: `Install ${status.release.version}`,
                targetDigest: view.targetDigest,
                idempotencyKey: key,
                primary: true,
              },
        notesVersion: status.release.version,
      };
    case 'current':
      return {
        ...base,
        status: { label: 'Up to date', tone: 'done' },
        title: view.title,
        detail: view.detail,
        action: null,
      };
    case 'incompatible':
      return {
        ...base,
        status: { label: 'Not installable', tone: 'problem' },
        title: view.title,
        detail: view.detail,
        action: null,
      };
    case 'unreachable':
    case 'unsupported':
      return {
        ...base,
        status: { label: 'Unknown', tone: 'idle' },
        title: view.title,
        detail: view.detail,
        action: null,
      };
  }
}

/**
 * The whole update screen: what is installed, then one card per thing the
 * operator can look at or act on, in order — the operation first, then a
 * release on offer. Release notes sit inside the card of the version on offer,
 * never beside an operation for another version.
 */
export function describeServerUpdatePanel(status: ServerUpdateStatus): ServerUpdatePanel {
  const operation = status.operation;
  const running =
    status.installed?.version ?? (status.state === 'current' ? status.release.version : null);
  // An unfinished operation is the news, even when the channel has nothing newer.
  const upToDate =
    status.state === 'current' && (operation === null || operation.state === 'completed');
  const installed =
    running === null
      ? null
      : {
          version: running,
          publishedAt: upToDate ? status.release.publishedAt : null,
          upToDate,
        };
  const view = describeServerUpdate(status);
  const offer =
    status.state === 'available' && view.targetDigest !== null && view.idempotencyKey !== null
      ? view.idempotencyKey
      : null;

  if (operation === null || operation.state === 'completed') {
    // Nothing to do: the installed row already says so.
    if (upToDate) return { installed, cards: [] };
    return { installed, cards: [availabilityCard(status, offer ?? attemptKeyFor(status))] };
  }

  const target = operationVersion(status, operation);
  const named = target?.version ?? 'the new version';
  const error = attemptError(status, operation);

  if (isBusy(operation.state) && status.stalled !== true) {
    return {
      installed,
      cards: [
        {
          key: operation.updateId,
          section: 'Update',
          status: {
            label: operation.state === 'rolling-back' ? 'Rolling back' : 'In progress',
            tone: 'active',
          },
          title:
            operation.state === 'rolling-back'
              ? 'Restoring the previous version'
              : `Installing ${named}`,
          release: target?.publishedAt ? target : null,
          detail: OPERATION_DETAIL[operation.state],
          progress: {
            step: operation.step,
            total: operation.totalSteps,
            phase: phaseLabel(operation.phase),
          },
          stalled: null,
          error,
          action: null,
          notesVersion: target?.publishedAt ? target.version : null,
        },
      ],
    };
  }

  if (isBusy(operation.state)) {
    const supersede = status.recovery?.supersede === true && offer !== null;
    const promoted = PROMOTED.includes(operation.phase);
    const stuck: ServerUpdateCard = {
      key: operation.updateId,
      section: 'Unfinished update',
      status: { label: 'Stuck', tone: 'problem' },
      title: `Update to ${named} did not finish`,
      release: null,
      detail: promoted
        ? `${named === 'the new version' ? 'The new version' : named} is already running. Only the companion services were not updated.`
        : status.recovery?.retry === true
          ? 'Retrying resumes the update where it stopped, or rolls it back. A newer version can be installed once it has finished.'
          : 'This server cannot resume the update from the app. Restarting the Updater on the host resumes it.',
      progress: null,
      stalled: {
        phase: phaseLabel(operation.phase),
        step: operation.step,
        total: operation.totalSteps,
        since: operation.updatedAt,
      },
      error,
      action:
        status.recovery?.retry === true
          ? {
              kind: 'retry',
              label: target === null ? 'Retry' : `Retry ${target.version}`,
              updateId: operation.updateId,
              primary: !supersede,
            }
          : null,
      notesVersion: null,
    };
    if (!supersede || status.state !== 'available') return { installed, cards: [stuck] };
    return {
      installed,
      cards: [
        stuck,
        {
          ...availabilityCard(status, offer),
          key: 'supersede',
          section: 'Available',
          status: { label: 'New version', tone: 'active' },
          title: `Version ${status.release.version} available`,
          detail: `Replaces the unfinished update. Verity finishes or skips the stuck step, then installs ${status.release.version}.`,
        },
      ],
    };
  }

  // Failed or rolled back: the outcome stays visible, and a way forward is
  // offered on the same card when it is the same release, else on its own.
  const outcome = describeOperation(operation);
  const failure: ServerUpdateCard = {
    key: operation.updateId,
    section: 'Update',
    status: {
      label: operation.state === 'rolled-back' ? 'Rolled back' : 'Failed',
      tone: 'problem',
    },
    title:
      target === null
        ? outcome.title
        : `Update to ${target.version} ${operation.state === 'rolled-back' ? 'was rolled back' : 'failed'}`,
    release: target?.publishedAt ? target : null,
    detail: outcome.detail,
    progress: null,
    stalled: null,
    error,
    action: null,
    notesVersion: null,
  };
  if (status.state !== 'available' || offer === null) return { installed, cards: [failure] };
  if (status.release.serverImage === operation.targetDigest)
    return {
      installed,
      cards: [
        {
          ...failure,
          action: {
            kind: 'install',
            label: 'Try again',
            targetDigest: status.release.serverImage,
            idempotencyKey: offer,
            primary: true,
          },
          notesVersion: status.release.version,
        },
      ],
    };
  return {
    installed,
    cards: [failure, { ...availabilityCard(status, offer), section: 'Available' }],
  };
}

function attemptKeyFor(status: ServerUpdateStatus): string | null {
  return status.state === 'available'
    ? attemptKey(status.release.serverImage, status.operation)
    : null;
}
