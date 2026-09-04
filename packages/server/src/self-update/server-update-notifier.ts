/**
 * Tell someone a release exists.
 *
 * ADR 0008 D11 makes an update an app-initiated action guarded by a fresh
 * master-password verification, and that is deliberate. But nothing in that path
 * makes anyone *look*: availability is resolved only when the settings screen asks
 * for it, so a deployment whose owner never opens that screen stays on the release
 * it was installed with, indefinitely, while believing itself current.
 *
 * This closes that half. It does not start, choose, or authorize anything — it
 * observes the signed release channel on a timer and sends one push per new
 * version. The decision stays exactly where D11 put it.
 *
 * ## Announced once, and remembered across restarts
 *
 * The state file is the whole design. Without it the choice is between announcing
 * on every tick (a notification every few minutes for as long as the update is
 * pending) and announcing only on an in-process change (silence for any release
 * that lands while the Server is restarting — which is precisely when a Server
 * restarts, since it just updated). Persisting the last announced version costs
 * one small file and removes both failure modes.
 *
 * The file is written only AFTER the push is accepted. A push that fails is
 * therefore retried on the next tick rather than swallowed; the cost is that a
 * send which succeeded while the write failed announces twice. A duplicate
 * notification is a far smaller harm than a silent one, and that is the trade
 * this ordering picks on purpose.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PushNotification } from '../push-sender.js';
import type { ServerUpdateAvailability } from './release-channel.js';
import { isTerminalOperationState, type UpdateOperation } from './update-operation.js';

/** Category the app keys its notification handling on, like the other fire points. */
export const SERVER_UPDATE_PUSH_CATEGORY = 'SERVER_UPDATE_AVAILABLE';

/**
 * Fifteen minutes: the channel document changes at most a few times a week, and
 * the resolver caches for five, so anything faster only re-reads its own cache.
 * Slow enough to be invisible, fast enough that an operator who publishes a
 * release hears about it within the quarter hour.
 */
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

/**
 * What delivery reports back. `PushSendResult` satisfies this structurally, so
 * the Server hands `PushSender.send` straight in.
 *
 * The count is load-bearing rather than decorative: `PushSender.send` resolves
 * whether or not anything left the building — no registered device, an Expo
 * request that failed, a token Expo rejected all end in a resolved promise. A
 * notifier that read "resolved" as "announced" would then write the version down
 * and never mention that release again, which is precisely the silence this
 * whole file exists to remove.
 */
interface PushDelivery {
  /** Notifications Expo accepted for delivery. Zero means nobody was told. */
  readonly ticketsAccepted: number;
}

export interface ServerUpdateNotifierOptions {
  /** The signed release channel, exactly as `/server/updates` reads it. */
  readonly resolve: () => Promise<ServerUpdateAvailability>;
  /**
   * The live update operation, as `/server/updates` overlays it onto availability.
   *
   * Required, not optional, and that is the point: the only source is the Updater
   * control channel, and a deployment without one gets 503 from `POST /server/updates`.
   * Demanding it here makes it impossible to construct a notifier for a deployment
   * that could not act on what it announces.
   *
   * The resolver alone cannot answer this — `ServerUpdateAvailability.operation` is
   * hard-coded `null` on every branch of `release-channel.ts`, and only the route
   * fills it in from the Updater's journal. A notifier reading availability alone
   * sees a plain `available` while the very update it describes is being installed.
   *
   * A throw (an Updater that cannot be reached) falls into the outer catch and skips
   * the pass without recording anything, which is the same refusal to guess "nothing
   * is running" that makes `GET /server/updates` answer 503 rather than a reassuring
   * null.
   */
  readonly readOperation: () => Promise<UpdateOperation | null>;
  /** Delivery. Accepted means "handed to Expo", not "seen". */
  readonly notify: (notification: PushNotification) => Promise<PushDelivery>;
  /** File remembering the last announced version; created with its parent. */
  readonly statePath: string;
  readonly intervalMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

type ServerUpdateNotice =
  'announced' | 'already-announced' | 'nothing-to-announce' | 'undelivered' | 'update-in-progress';

export interface ServerUpdateNotifier {
  /** One pass. Never throws — a notifier that crashes the process it advises is
   *  worse than one that stays quiet about a release. */
  check(): Promise<ServerUpdateNotice>;
  start(): void;
  /**
   * Stops the timer and resolves once any pass already running has finished, so
   * nothing this notifier does can outlive the `onClose` hook that awaits it and
   * land on a push sender or a filesystem that is already shutting down.
   */
  close(): Promise<void>;
}

/** The path this notifier keeps its state at, given the Server's data root. */
export const serverUpdateNotifierStatePath = (verityRoot: string): string =>
  join(verityRoot, 'server-state', 'announced-release.json');

async function readAnnounced(path: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : null;
  } catch {
    // Missing, unreadable, or corrupt all mean the same thing to the caller:
    // nothing is known to have been announced. The cost of being wrong is one
    // duplicate notification.
    return null;
  }
}

async function writeAnnounced(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Renamed into place so a reader concurrent with a write sees one whole file or
  // the other, never a truncated one that would read as "nothing announced".
  const scratch = `${path}.tmp`;
  await writeFile(scratch, `${JSON.stringify({ version })}\n`, { mode: 0o600 });
  await rename(scratch, path);
}

export function createServerUpdateNotifier(
  options: ServerUpdateNotifierOptions,
): ServerUpdateNotifier {
  const intervalMs = options.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
  const log = options.log ?? (() => undefined);
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let closed = false;
  /** The pass currently running, if any — what `close()` waits for. */
  let inFlight: Promise<void> | undefined;
  /**
   * The second lock on "once per release", and the one that does not depend on a
   * filesystem. The state file survives restarts but can fail to be written —
   * a full disk, a read-only mount — and if the only record of an announcement
   * were that file, a persistent write failure would turn the timer into a
   * notification every quarter of an hour, which is the exact behaviour this
   * whole design exists to avoid. With this, the worst a broken state file can
   * cost is one notification per process start.
   */
  let announcedHere: string | undefined;

  let checkInFlight: Promise<ServerUpdateNotice> | undefined;
  const performCheck = async (): Promise<ServerUpdateNotice> => {
    try {
      const availability = await options.resolve();
      // Only `available` is worth a notification. `current` is the happy path,
      // `unsupported` is a deployment that cannot act on one anyway, and
      // `incompatible` names a release this Server must NOT be pushed towards —
      // announcing it would invite an action the API would then refuse.
      if (availability.state !== 'available') return 'nothing-to-announce';
      const version = availability.release.version;
      if (announcedHere === version) return 'already-announced';
      if ((await readAnnounced(options.statePath)) === version) return 'already-announced';
      // An update already under way makes this release nothing to act on: the app
      // shows progress, the badge deliberately goes dark, and POST /server/updates
      // would refuse a second one. Announcing here would be the same mistake as
      // announcing `incompatible` — an invitation to an action that is not available.
      //
      // Nothing is recorded, so the release stays open: an operation that fails or
      // is abandoned leaves the version genuinely available, and the next pass says
      // so. If the operation succeeds, the resolver reports `current` and there is
      // nothing left to announce anyway.
      //
      // Under way, not merely present. The Updater keeps the last journal until
      // the next accepted request archives it, and it accepts one precisely when
      // the previous operation is terminal — so treating any operation as an
      // update in progress would announce nothing ever again after the first
      // attempt, whether that attempt failed, rolled back, or installed a version
      // that a later release has since superseded.
      const operation = await options.readOperation();
      if (operation !== null && !isTerminalOperationState(operation.state))
        return 'update-in-progress';
      const delivery = await options.notify({
        title: 'Verity update available',
        body: `Version ${version} is ready to install.`,
        categoryId: SERVER_UPDATE_PUSH_CATEGORY,
        data: { kind: 'server-update', version },
      });
      // Nothing was announced if nothing was accepted, and writing the version
      // down here would retire the release permanently after telling no one.
      // A deployment that has not paired a device yet is the ordinary case —
      // it is also the deployment most likely to be sitting on an old release.
      // Retrying costs one token-store read per pass and sends no push at all
      // until there is somewhere to send it.
      if (delivery.ticketsAccepted < 1) {
        log(`Verity ${version} is available; no device accepted the notification`);
        return 'undelivered';
      }
      // Recorded in memory the instant the push is accepted, and BEFORE the write
      // that may fail. A send that succeeded must never be repeated by this
      // process, whatever the disk does next.
      announcedHere = version;
      try {
        await writeAnnounced(options.statePath, version);
      } catch (error) {
        log(`announced Verity ${version} but could not persist it; a restart may repeat it`, error);
        return 'announced';
      }
      log(`announced Verity ${version}`);
      return 'announced';
    } catch (error) {
      log('release-channel notification check failed', error);
      return 'nothing-to-announce';
    }
  };
  const check = (): Promise<ServerUpdateNotice> => {
    if (checkInFlight !== undefined) return checkInFlight;
    const pass = performCheck().finally(() => {
      if (checkInFlight === pass) checkInFlight = undefined;
    });
    checkInFlight = pass;
    return pass;
  };

  return {
    check,
    start() {
      if (timer !== undefined || closed) return;
      // Checked on start as well as on the timer: a release published while this
      // deployment was down is exactly the case the state file makes safe to
      // announce late.
      void guarded();
      timer = setInterval(() => void guarded(), intervalMs);
      // Never keep the process alive for a notification.
      timer.unref?.();
    },
    async close() {
      closed = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // The pass started by `start()` is the one that matters: it runs a channel
      // fetch and a push, and a server closing immediately after boot would
      // otherwise leave it writing state behind the shutdown. Awaiting it costs a
      // shutdown the tail of one check and makes the ordering total.
      await inFlight;
    },
  };

  /** Serialised: a slow channel read must not overlap with the next tick and
   *  announce the same version twice from two passes that both read "none".
   *  The pass is also published as `inFlight` so `close()` can wait it out. */
  async function guarded(): Promise<void> {
    if (running || closed) return;
    running = true;
    const pass = check().then(
      () => undefined,
      () => undefined,
    );
    inFlight = pass;
    try {
      await pass;
    } finally {
      running = false;
      if (inFlight === pass) inFlight = undefined;
    }
  }
}
