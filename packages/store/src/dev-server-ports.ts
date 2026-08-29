export const DEV_SERVER_HOST_PORT_RANGES = [
  { start: 3000, end: 3099 },
  { start: 8000, end: 8099 },
] as const;

export class DevServerPortRangeExhaustedError extends Error {
  constructor() {
    super('no free dev-server host port remains in 3000-3099 or 8000-8099');
    this.name = 'DevServerPortRangeExhaustedError';
  }
}

export function isManagedDevServerHostPort(value: string | null): value is string {
  if (value === null || !/^\d+$/.test(value)) return false;
  const port = Number(value);
  return DEV_SERVER_HOST_PORT_RANGES.some((range) => port >= range.start && port <= range.end);
}

export function nextFreeDevServerHostPort(used: ReadonlySet<string>): string {
  for (const range of DEV_SERVER_HOST_PORT_RANGES) {
    for (let port = range.start; port <= range.end; port += 1) {
      const candidate = String(port);
      if (!used.has(candidate)) return candidate;
    }
  }
  throw new DevServerPortRangeExhaustedError();
}
