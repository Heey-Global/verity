import {
  selectedConnectionRecordingStatusSchema,
  type SelectedConnectionRecordingStatus,
} from '@verity/mobile';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { requireNativeModule } from 'expo-modules-core';
import {
  requestRemoteControlAdmission,
  type RemoteAdmissionOptions,
} from './remoteControlAdmission';
import { createPairedSelectedRecordingArming } from './selectedRecordingArming';
import { createPinnedFetch } from './pinnedTransport';
import { exportRemoteDataDiagnostics, selectRemoteRecording } from './remoteDataDiagnostics';

interface Tunnel {
  isActive(): Promise<boolean>;
  start(dataUrl: string, ticket: string, sessionId: string, coreUrl: string): Promise<number>;
  stop(): Promise<void>;
  captureDataDiagnostics?(): Promise<boolean>;
  dataDiagnosticsRemainingMs?(): Promise<number>;
  disableDataDiagnostics?(): Promise<void>;
}
interface Pinned {
  request(
    id: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    body: null,
    pin: string,
    port: number,
  ): Promise<{ status: number }>;
  cancelRequest(id: string): Promise<unknown>;
}
export interface SelectedLocalRecording {
  status: 'ready' | 'unsupported' | 'empty' | 'invalid' | 'failed' | 'unmatched' | 'ambiguous';
  recording: string | null;
  sessionHash: string | null;
  stopped: boolean;
}
export interface SelectedRecordingAttemptOptions extends Omit<
  RemoteAdmissionOptions,
  'diagnosticArming'
> {
  coreUrl: string;
  corePin: string;
  getToken: () => string | null | undefined;
  runId: string;
  installationFingerprint: string;
  /** Observed response only; successful cleanup is reported by resolution. */
  onResponse?: (status: number) => void;
  /** Validated native evidence for this session only, including unsuccessful attempts. */
  onLocalRecording?: (evidence: SelectedLocalRecording) => void | Promise<void>;
  onPhase?: (phase: 'preparing' | 'running' | 'stopping') => void;
}
let occupied = false;

/** Explicit diagnostic caller only: one attachment and one GET, with no fallback or retry. */
export async function selectedRecordingAttempt(
  options: SelectedRecordingAttemptOptions,
): Promise<{ status: number }> {
  if (occupied) throw new Error('Selected attempt already active');
  const tunnel = requireNativeModule<Tunnel>('VerityRemoteControlTunnel');
  const pinned = requireNativeModule<Pinned>('VerityPinnedTransport');
  occupied = true;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const outer = setTimeout(abort, 60_000);
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let ownsTunnel = false;
  let startPending = false;
  let cleanupDone = false;
  let capturePending = false;
  let ownsCapture = false;
  let ownsCaptureEvidence = false;
  let disablePending = false;
  let disableOperation: Promise<void> | null = null;
  let captureCleanupFailed = false;
  let captureStartedAt = 0;
  let captureExpiresAt = 0;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let captureStatus: SelectedLocalRecording['status'] = 'unsupported';
  let nativeStopped = false;
  const release = () => {
    if (cleanupDone && !startPending && !capturePending && !disablePending) occupied = false;
  };
  const disableCapture = () => {
    if (!disableOperation) {
      disablePending = true;
      disableOperation = Promise.resolve()
        .then(() => tunnel.disableDataDiagnostics!())
        .then(() => {
          ownsCapture = false;
        })
        .finally(() => {
          disablePending = false;
          release();
        });
    }
    return disableOperation;
  };
  let liveDeadline = performance.now() + 60000;
  let utcDeadline = Infinity;
  let armAttempted = false;
  let selectedSessionHash: string | undefined;
  let admission: Awaited<ReturnType<typeof requestRemoteControlAdmission>> | undefined;
  const requestId = `selected-${options.runId}`;
  const phase = (value: 'preparing' | 'running' | 'stopping') => {
    try {
      options.onPhase?.(value);
    } catch {
      /* A UI observer cannot prevent cleanup. */
    }
  };
  const check = () => {
    if (controller.signal.aborted || performance.now() >= liveDeadline || Date.now() >= utcDeadline)
      throw new Error('Selected attempt stopped');
  };
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let listener!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      listener = () => reject(new Error('Selected attempt stopped'));
      controller.signal.addEventListener('abort', listener, { once: true });
      if (controller.signal.aborted) listener();
    });
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      controller.signal.removeEventListener('abort', listener);
    }
  };
  const stopOnAbort = () => {
    if (ownsTunnel) void tunnel.stop().catch(() => {});
    void pinned.cancelRequest(requestId).catch(() => {});
  };
  controller.signal.addEventListener('abort', stopOnAbort);
  // Cleanup has its own fixed budget, even when the attempt signal is already aborted.
  const cleanup = async (operation: Promise<unknown>) => {
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Selected cleanup timed out')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let adminFetch: ReturnType<typeof createPinnedFetch> | undefined;
  const admin = async (method: string, suffix: string, signal?: AbortSignal) => {
    const token = options.getToken();
    if (!token) throw new Error('Paired administrator token unavailable');
    const response = await adminFetch!(
      `${options.coreUrl.replace(/\/$/u, '')}/api/remote-control/recordings/${options.runId}${suffix}`,
      {
        method,
        headers: { authorization: `Bearer ${token}` },
        signal,
      },
    );
    if (!response.ok) throw new Error('Selected recording request failed');
    return selectedConnectionRecordingStatusSchema.parse(await response.json());
  };
  try {
    phase('preparing');
    check();
    const arming = createPairedSelectedRecordingArming({ ...options, durationMs: 30000 });
    adminFetch = createPinnedFetch(options.corePin, false);
    if (await bounded(tunnel.isActive()))
      throw new Error('Existing DATA tunnel must be stopped first');
    let armed: SelectedConnectionRecordingStatus | undefined;
    let armMonotonic = 0;
    admission = await bounded(
      requestRemoteControlAdmission({
        ...options,
        signal: controller.signal,
        diagnosticArming: {
          ...arming,
          arm: async (sessionId, signal) => {
            selectedSessionHash = (
              await digestStringAsync(CryptoDigestAlgorithm.SHA256, sessionId)
            ).slice(0, 16);
            check();
            armAttempted = true;
            armMonotonic = performance.now();
            const result = await arming.arm(sessionId, signal);
            check();
            armed = selectedConnectionRecordingStatusSchema.parse(result);
            const remaining = Math.min(45000, Date.parse(armed.expiresAt) - Date.now());
            if (remaining <= 0) throw new Error('Selected recording expired');
            utcDeadline = Date.parse(armed.expiresAt);
            liveDeadline = Math.min(liveDeadline, performance.now() + remaining);
            const preparationRemaining =
              Date.parse(armed.selection.preparationExpiresAt ?? '') - Date.now();
            if (!Number.isFinite(preparationRemaining) || preparationRemaining <= 0)
              throw new Error('Selected preparation expired');
            expiry = setTimeout(abort, Math.min(remaining, preparationRemaining));
            return result;
          },
        },
      }),
    );
    const sessionHash = (
      await bounded(digestStringAsync(CryptoDigestAlgorithm.SHA256, admission.sessionId))
    ).slice(0, 16);
    if (
      !armed ||
      !armed.selection.confirmed ||
      armed.selection.sessionHash !== sessionHash ||
      armed.installationFingerprint !== options.installationFingerprint ||
      armed.runId !== options.runId ||
      !armed.selection.preparationExpiresAt ||
      Date.parse(armed.selection.preparationExpiresAt) <= Date.now() ||
      admission.expiresAt <= Date.now()
    )
      throw new Error('Invalid selected preparation');
    // Recheck after admission: never arm capture on a different active tunnel.
    if (await bounded(tunnel.isActive()))
      throw new Error('Existing DATA tunnel must be stopped first');
    if (
      tunnel.captureDataDiagnostics &&
      tunnel.dataDiagnosticsRemainingMs &&
      tunnel.disableDataDiagnostics
    ) {
      const remaining = await bounded(tunnel.dataDiagnosticsRemainingMs());
      if (!Number.isFinite(remaining) || remaining !== 0)
        throw new Error('Existing DATA recording must be stopped first');
      captureStartedAt = Date.now();
      captureExpiresAt = Math.min(captureStartedAt + 30000, utcDeadline);
      capturePending = true;
      captureStatus = 'failed';
      const preparing = tunnel
        .captureDataDiagnostics()
        .then(async (enabled) => {
          ownsCapture = enabled;
          ownsCaptureEvidence = enabled;
          if (enabled && controller.signal.aborted) {
            await disableCapture();
            ownsCapture = false;
          }
          return enabled;
        })
        .finally(() => {
          capturePending = false;
          release();
        });
      if (!(await bounded(preparing))) throw new Error('Native recording unavailable');
      check();
      captureTimer = setTimeout(
        () => {
          // Preserve the original absolute budget; reading/exporting never renews it.
          if (ownsCapture) void disableCapture().catch(() => {});
        },
        Math.max(0, captureExpiresAt - Date.now()),
      );
    }
    const data = new URL(options.uplinkOrigin);
    data.protocol = 'wss:';
    data.pathname = '/data';
    ownsTunnel = true;
    startPending = true;
    const starting = tunnel
      .start(data.href, admission.ticket, admission.sessionId, options.coreUrl)
      .then(async (port) => {
        if (controller.signal.aborted) {
          await tunnel.stop();
          throw new Error('Late DATA attachment');
        }
        return port;
      })
      .finally(() => {
        startPending = false;
        release();
      });
    const port = await bounded(starting);
    admission.finish();
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid DATA listener');
    let revision = armed.selection.readiness?.revision ?? -1;
    let previousReadiness = armed.selection.readiness;
    let pair: string | undefined;
    const captureDeadline = performance.now() + 30000;
    for (let i = 0; i < 2; i++) {
      const status = await bounded(admin('GET', '/selection', controller.signal));
      const ready = status.selection.readiness;
      check();
      if (
        status.runId !== options.runId ||
        status.installationFingerprint !== options.installationFingerprint ||
        status.selection.sessionHash !== sessionHash ||
        !status.selection.confirmed ||
        status.phase !== 'recording' ||
        status.error !== null ||
        !ready?.ready ||
        ready.revision < revision ||
        (previousReadiness !== undefined &&
          previousReadiness !== null &&
          (ready.monotonicMs < previousReadiness.monotonicMs ||
            (ready.revision === revision &&
              JSON.stringify([ready.installation, ready.app, ready.ready]) !==
                JSON.stringify([
                  previousReadiness.installation,
                  previousReadiness.app,
                  previousReadiness.ready,
                ])))) ||
        Date.parse(status.expiresAt) <= Date.now() ||
        performance.now() - armMonotonic >= 45000
      )
        throw new Error('Selected readiness unavailable');
      for (const peer of [ready.installation, ready.app])
        if (!peer.bound || !peer.active || !peer.socketLifetimeId || !peer.generation)
          throw new Error('Selected socket unavailable');
      const original = armed.selection.readiness;
      if (original)
        for (const side of ['installation', 'app'] as const) {
          if (
            (original[side].generation && original[side].generation !== ready[side].generation) ||
            (original[side].socketLifetimeId &&
              original[side].socketLifetimeId !== ready[side].socketLifetimeId)
          )
            throw new Error('Selected socket changed');
        }
      const current = JSON.stringify([ready.installation, ready.app]);
      if (pair !== undefined && pair !== current) throw new Error('Selected socket changed');
      pair = current;
      revision = ready.revision;
      previousReadiness = ready;
      // Status reads never renew capture. Retain the earliest absolute deadline.
      const remaining =
        Math.min(Date.parse(status.expiresAt), Date.parse(armed.expiresAt)) - Date.now();
      if (remaining <= 0) throw new Error('Selected recording expired');
      utcDeadline = Math.min(utcDeadline, Date.parse(status.expiresAt));
      liveDeadline = Math.min(liveDeadline, performance.now() + remaining, captureDeadline);
      clearTimeout(expiry);
      expiry = setTimeout(
        abort,
        Math.min(
          remaining,
          45000 - (performance.now() - armMonotonic),
          captureDeadline - performance.now(),
        ),
      );
    }
    check();
    phase('running');
    const warmup = setTimeout(abort, 5000);
    try {
      const result = await bounded(
        pinned.request(
          requestId,
          new URL('/healthz', options.coreUrl).href,
          'GET',
          {},
          null,
          options.corePin,
          port,
        ),
      );
      check();
      options.onResponse?.(result.status);
      if (result.status !== 200) throw new Error('Selected warmup failed');
      return { status: result.status };
    } finally {
      clearTimeout(warmup);
    }
  } finally {
    phase('stopping');
    controller.abort();
    clearTimeout(outer);
    clearTimeout(expiry);
    options.signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', stopOnAbort);
    admission?.cancel();
    try {
      const stops: Promise<unknown>[] = [];
      if (ownsTunnel)
        stops.push(
          cleanup(
            (async () => {
              await tunnel.stop();
              if (await tunnel.isActive()) throw new Error('DATA tunnel remains active');
              nativeStopped = true;
            })(),
          ),
        );
      if (armAttempted) {
        const stopController = new AbortController();
        const stopTimer = setTimeout(() => stopController.abort(), 3000);
        stops.push(
          cleanup(
            (async () => {
              const stopped = await admin('DELETE', '', stopController.signal);
              if (
                stopped.runId !== options.runId ||
                stopped.installationFingerprint !== options.installationFingerprint ||
                !selectedSessionHash ||
                stopped.selection.sessionHash !== selectedSessionHash ||
                !['stopped', 'expired'].includes(stopped.phase) ||
                stopped.core.state !== 'stopped' ||
                stopped.uplink.state !== 'stopped' ||
                stopped.error !== null ||
                stopped.selection.confirmed ||
                stopped.selection.readiness?.ready === true
              )
                throw new Error('Invalid terminal recording receipt');
            })(),
          ).finally(() => clearTimeout(stopTimer)),
        );
      }
      const results = await Promise.allSettled(stops);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw new Error('Selected cleanup failed');
    } finally {
      let recording: string | null = null;
      // A late native start still owns the singleton until its stop handler runs.
      try {
        if (ownsCaptureEvidence && !startPending) {
          // Delegate callbacks may follow stop(). Keep a bounded grace inside the
          // original capture deadline instead of freezing the first cancellation.
          const grace =
            performance.now() + Math.min(250, Math.max(0, captureExpiresAt - Date.now()));
          do {
            let exportTimer: ReturnType<typeof setTimeout> | undefined;
            const result = await Promise.race([
              exportRemoteDataDiagnostics(),
              new Promise<{ status: 'failed' }>((resolve) => {
                exportTimer = setTimeout(() => resolve({ status: 'failed' }), 300);
              }),
            ]).finally(() => clearTimeout(exportTimer));
            captureStatus = result.status;
            if (result.status === 'ready') {
              const window = selectRemoteRecording(
                result.recording,
                captureStartedAt,
                captureExpiresAt,
              );
              const candidates = window
                ? (
                    JSON.parse(window) as Array<{
                      sessionHash?: string;
                      generation: string;
                      delegateAvailable: boolean;
                      events: Array<{ event: string }>;
                    }>
                  ).filter((entry) => entry.sessionHash === selectedSessionHash)
                : [];
              if (candidates.length === 1) {
                recording = JSON.stringify(candidates);
                captureStatus = 'ready';
                const selected = candidates[0]!;
                if (
                  !selected.delegateAvailable ||
                  selected.events.some((entry) => entry.event === 'task_completed')
                )
                  break;
              } else {
                recording = null;
                captureStatus = candidates.length > 1 ? 'ambiguous' : 'unmatched';
              }
            }
            const remaining = grace - performance.now();
            if (remaining <= 0) break;
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
          } while (true);
          try {
            await cleanup(disableCapture());
          } catch (error) {
            captureCleanupFailed = true;
            throw error;
          }
          await options.onLocalRecording?.({
            status: captureStatus,
            recording,
            sessionHash: selectedSessionHash ?? null,
            stopped: nativeStopped,
          });
        } else {
          await options.onLocalRecording?.({
            status: captureStatus,
            recording: null,
            sessionHash: selectedSessionHash ?? null,
            stopped: nativeStopped,
          });
        }
      } catch {
        // Persistence/export failures must not mask the attempt or its cleanup error.
        try {
          await options.onLocalRecording?.({
            status: recording ? captureStatus : 'failed',
            recording,
            sessionHash: selectedSessionHash ?? null,
            stopped: nativeStopped,
          });
        } catch {
          /* caller owns persistence */
        }
      } finally {
        clearTimeout(captureTimer);
        if (ownsCapture && !captureCleanupFailed) {
          try {
            await cleanup(disableCapture());
          } catch {
            captureCleanupFailed = true;
          }
        }
        cleanupDone = true;
        release();
        if (captureCleanupFailed) throw new Error('Selected native capture cleanup failed');
      }
    }
  }
}
