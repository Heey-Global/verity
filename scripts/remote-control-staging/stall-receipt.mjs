/**
 * @typedef {{mapping: string, queued: number, sending: number, completed: number, failed: number,
 * globalQueued: number, globalSending: number, oldestSendMs: number, overflow: boolean}} StallWriter
 * @typedef {{headersMs: number, firstByteMs: number, completedMs: number, writer: StallWriter}} StallDiagnostic
 * @typedef {{worker: number, ownRequests: number, totalRequests: number, kind: string,
 * code: number | null, phase: string, diagnostic: StallDiagnostic}} StallReceipt
 */
// Native stdout is untrusted. Reject unknown fields rather than forwarding a
// nested object which could silently start exporting addresses or payloads.
/** @param {string} line @returns {StallReceipt | null} */
export function parseStallReceipt(line) {
  const prefix = /^probe-(stall|warmup)-failure:/u.exec(line);
  if (!prefix || line.length > 4096) return null;
  try {
    const value = JSON.parse(line.slice(prefix[0].length));
    /** @param {unknown} object @param {string[]} allowed */
    const keys = (object, allowed) =>
      object !== null &&
      typeof object === 'object' &&
      !Array.isArray(object) &&
      Object.keys(object).length === allowed.length &&
      allowed.every((key) => Object.hasOwn(object, key));
    /** @param {unknown} number @param {number} min @param {number} max */
    const integer = (number, min, max) =>
      typeof number === 'number' && Number.isSafeInteger(number) && number >= min && number <= max;
    if (
      !keys(value, [
        'worker',
        'ownRequests',
        'totalRequests',
        'kind',
        'code',
        'phase',
        'diagnostic',
      ])
    )
      return null;
    if (
      !integer(value.worker, 0, 7) ||
      !integer(value.ownRequests, 0, 999999999) ||
      !integer(value.totalRequests, value.ownRequests, 999999999) ||
      (!(value.kind === 'http_response' && value.code === null) &&
        !integer(value.code, -999999999, 999999999)) ||
      !['transport', 'http_response'].includes(value.kind) ||
      !['NO_AUTH_CHALLENGE', 'AUTH_CHALLENGE_RECEIVED', 'PIN_AND_CHAIN_TRUST_ACCEPTED'].includes(
        value.phase,
      )
    )
      return null;
    if (
      prefix[1] === 'warmup' &&
      (value.worker !== 0 || value.ownRequests > 2 || value.totalRequests !== value.ownRequests)
    )
      return null;
    const d = value.diagnostic;
    if (
      !keys(d, ['headersMs', 'firstByteMs', 'completedMs', 'writer']) ||
      !integer(d.completedMs, 0, 86400000) ||
      !integer(d.headersMs, -1, d.completedMs) ||
      !integer(d.firstByteMs, -1, d.completedMs) ||
      (d.firstByteMs !== -1 && (d.headersMs === -1 || d.firstByteMs < d.headersMs))
    )
      return null;
    const w = d.writer;
    if (
      !keys(w, [
        'mapping',
        'queued',
        'sending',
        'completed',
        'failed',
        'globalQueued',
        'globalSending',
        'oldestSendMs',
        'overflow',
      ]) ||
      !['matched', 'unknown', 'ambiguous', 'overflow'].includes(w.mapping) ||
      typeof w.overflow !== 'boolean' ||
      w.overflow !== (w.mapping === 'overflow') ||
      !integer(w.globalQueued, 0, 128) ||
      !integer(w.globalSending, 0, 128) ||
      w.globalQueued + w.globalSending > 128 ||
      !integer(w.oldestSendMs, 0, 86400000)
    )
      return null;
    for (const key of ['queued', 'sending', 'completed', 'failed']) {
      if (w.mapping === 'matched') {
        if (!integer(w[key], 0, key === 'queued' || key === 'sending' ? 128 : 1000000000))
          return null;
      } else if (w[key] !== -1) return null;
    }
    if (w.mapping === 'matched' && (w.queued > w.globalQueued || w.sending > w.globalSending))
      return null;
    return value;
  } catch {
    return null;
  }
}
