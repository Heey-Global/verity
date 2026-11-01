/** Docker host capacity, never the Server container's own memory view. */
export const DEFAULT_SANDBOX_MEMORY_RESERVATION_BYTES = 4 * 1024 ** 3;
export const DEFAULT_SANDBOX_HOST_RESERVE_BYTES = 4 * 1024 ** 3;
export const FALLBACK_SANDBOX_MEMORY_BYTES = 6 * 1024 ** 3;
export const DEFAULT_SANDBOX_OOM_SCORE_ADJ = 500;

export function parseOomScoreAdj(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const score = Number(value);
  if (!Number.isInteger(score) || score < -1000 || score > 1000) {
    throw new Error('OOM score adjustment must be an integer between -1000 and 1000');
  }
  return score;
}

export function resolveSandboxMemory(input: {
  hostMemoryBytes?: number | undefined;
  memoryBytes?: number | undefined;
  reservationBytes?: number | undefined;
  hostReserveBytes?: number | undefined;
}): { memoryBytes: number; memoryReservationBytes: number } {
  const positive = (value: number | undefined, name: string): void => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive safe integer in bytes`);
    }
  };
  positive(input.hostMemoryBytes, 'Docker host memory');
  positive(input.memoryBytes, 'Sandbox memory');
  positive(input.reservationBytes, 'Sandbox memory reservation');
  positive(input.hostReserveBytes, 'Sandbox host reserve');
  const memoryBytes =
    input.memoryBytes ??
    (input.hostMemoryBytes === undefined
      ? FALLBACK_SANDBOX_MEMORY_BYTES
      : input.hostMemoryBytes - (input.hostReserveBytes ?? DEFAULT_SANDBOX_HOST_RESERVE_BYTES));
  if (
    memoryBytes <= 0 ||
    (input.hostMemoryBytes !== undefined && memoryBytes > input.hostMemoryBytes)
  ) {
    throw new Error(
      'Sandbox memory must fit Docker host capacity; configure VERITY_SANDBOX_MEMORY or VERITY_SANDBOX_HOST_RESERVE',
    );
  }
  const memoryReservationBytes =
    input.reservationBytes ?? Math.min(DEFAULT_SANDBOX_MEMORY_RESERVATION_BYTES, memoryBytes);
  if (memoryReservationBytes > memoryBytes) {
    throw new Error(
      'VERITY_SANDBOX_MEMORY_RESERVATION must not exceed the sandbox hard memory limit',
    );
  }
  return { memoryBytes, memoryReservationBytes };
}
