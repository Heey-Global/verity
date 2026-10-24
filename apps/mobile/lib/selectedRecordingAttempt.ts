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

interface Tunnel {
  isActive(): Promise<boolean>;
  start(dataUrl: string, ticket: string, sessionId: string, coreUrl: string): Promise<number>;
  stop(): Promise<void>;
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
  let liveDeadline = performance.now() + 60000;
  let utcDeadline = Infinity;
  let armAttempted = false;
  let selectedSessionHash: string | undefined;
  let admission: Awaited<ReturnType<typeof requestRemoteControlAdmission>> | undefined;
  const requestId = `selected-${options.runId}`;
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
        if (cleanupDone) occupied = false;
      });
    const port = await bounded(starting);
    admission.finish();
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid DATA listener');
    let revision = armed.selection.readiness?.revision ?? -1;
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
        ready.revision <= revision ||
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
      // A late native start still owns the singleton until its stop handler runs.
      cleanupDone = true;
      if (!startPending) occupied = false;
    }
  }
}
