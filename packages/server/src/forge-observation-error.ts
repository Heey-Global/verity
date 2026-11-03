/** Safe diagnostics: never persist provider bodies, request URLs or credentials. */
export class ForgeObservationError extends Error {
  constructor(
    readonly category:
      | 'credentials'
      | 'forbidden'
      | 'rate-limit'
      | 'timeout'
      | 'unavailable'
      | 'invalid-response'
      | 'unsupported',
    readonly step: string,
    readonly retryAt?: string,
  ) {
    super(`Repository observation: ${category} (${step})`);
  }
}
export function observationFailure(error: unknown, step = 'discovery') {
  return error instanceof ForgeObservationError
    ? {
        category: error.category,
        step: error.step,
        retryAt: error.retryAt,
        checkedAt: new Date().toISOString(),
      }
    : {
        category:
          error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
            ? 'timeout'
            : error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')
              ? 'invalid-response'
              : 'unavailable',
        step,
        checkedAt: new Date().toISOString(),
      };
}
