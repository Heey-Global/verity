import type { UplinkControlClientOptions } from './uplink-control-client.js';
import type {
  RemoteConnectorRequest,
  RemoteConnectorReservation,
  TeamJoinPending,
} from './uplink-control-frames.js';

/** Reserve transport before recording authority, and retire both on cancellation. */
export async function reserveRemoteAdmission(
  options: Pick<
    UplinkControlClientOptions,
    'reserveRemoteConnector' | 'admitTeamJoin' | 'rollbackTeamJoin' | 'log'
  >,
  request: RemoteConnectorRequest,
  signal: AbortSignal,
  join?: TeamJoinPending,
): Promise<RemoteConnectorReservation | 'unavailable' | 'limit_reached'> {
  let reservation: RemoteConnectorReservation | undefined;
  let released = false;
  let admissionStarted = false;
  const rollback = (): void => {
    if (join && admissionStarted)
      void options
        .rollbackTeamJoin?.(join)
        .catch((error: unknown) =>
          options.log?.warn({ error, sessionId: join.sessionId }, 'team admission rollback failed'),
        );
  };
  const release = (reason: string): void => {
    if (released) return;
    released = true;
    signal.removeEventListener('abort', onAbort);
    reservation?.release(reason);
    rollback();
  };
  let abort: () => void = () => undefined;
  const aborted = new Promise<'unavailable'>((resolve) => {
    abort = () => resolve('unavailable');
  });
  const onAbort = (): void => {
    release('remote admission aborted');
    abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const acquire = async (): Promise<
    RemoteConnectorReservation | 'unavailable' | 'limit_reached'
  > => {
    if (released) return 'unavailable';
    const result = (await options.reserveRemoteConnector?.(request, signal)) ?? 'unavailable';
    if (typeof result === 'string') {
      release(result);
      return result;
    }
    reservation = result;
    if (released || signal.aborted) {
      result.release('late reservation');
      return 'unavailable';
    }
    if (join) {
      admissionStarted = true;
      const decision = (await options.admitTeamJoin?.(join, signal)) ?? 'refused';
      if (released || signal.aborted) {
        // The store callback can finish after the deadline and after the first rollback.
        rollback();
        return 'unavailable';
      }
      if (decision !== 'accepted') {
        release('team join refused');
        return 'unavailable';
      }
    }
    return {
      ...result,
      attach: (...args) => result.attach(...args),
      release,
    };
  };
  try {
    return await Promise.race([acquire(), aborted]);
  } catch {
    release('remote admission failed');
    return 'unavailable';
  }
}
