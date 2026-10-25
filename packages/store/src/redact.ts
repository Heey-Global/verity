/**
 * Best-effort secret redaction for the persisted event log (security review M9).
 *
 * Secrets are deliberately injected into sandboxes as env vars / files, so any
 * agent turn that echoes one (`env`, `cat ~/.gh-token`, a failing command that
 * prints `$DOPPLER_TOKEN`) would otherwise persist the plaintext credential into
 * the `events` payload / attachment blobs — outside the encrypted-columns scheme,
 * and into DB backups. This masks well-known credential shapes before persist.
 *
 * It is a SAFETY NET, not a guarantee: it matches distinctive token prefixes /
 * key blocks, so novel formats slip through, and a secret split across streaming
 * text deltas (one prefix per event) is not reassembled here — redaction is
 * per-persisted-string. The live broadcast is intentionally NOT redacted (the
 * operator's own device already holds the plaintext); only the stored copy is.
 */

/** Ordered list of credential patterns. Each match is replaced wholesale by
 *  {@link REDACTED}. Anchored on distinctive prefixes to keep
 *  false positives negligible on ordinary transcript text. */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic / Claude keys: sk-ant-oat01-…, sk-ant-api03-…
  /sk-ant-[a-z0-9-]{8,}/gi,
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ + fine-grained github_pat_…
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Doppler service/personal/CLI tokens: dp.st.<config>.<secret>, dp.sa.…, dp.ct.…
  /dp\.(?:st|sa|ct|scim|audit)\.[A-Za-z0-9._-]{16,}/g,
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-…
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /AKIA[0-9A-Z]{16}/g,
  // OpenAI keys: sk-…, sk-proj-… (kept last + length-bounded to limit false hits).
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
];

/** The placeholder a matched secret is replaced with. */
export const REDACTED = '[REDACTED]';

/** Repeated opening markers must not restart a search through the remaining body. */
function redactPrivateKeys(text: string): string {
  const markers = /-----(BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu;
  const parts: string[] = [];
  let start: number | undefined;
  let cursor = 0;
  for (const match of text.matchAll(markers)) {
    if (match[1] === 'BEGIN') {
      start ??= match.index;
    } else if (start !== undefined) {
      parts.push(text.slice(cursor, start), REDACTED);
      cursor = match.index + match[0].length;
      start = undefined;
    }
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Replace any recognized credential in `text` with {@link REDACTED}. Safe to run
 * over a JSON-serialized event payload: token characters never include JSON
 * structural characters (`"`, `{`, `,`), so replacing a token value in-place keeps
 * the surrounding JSON valid. Returns the input unchanged when nothing matches.
 */
export function redactSecrets(text: string): string {
  let out = redactPrivateKeys(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Redact process diagnostics before they reach any sink, including live logs. */
export function redactProcessStderr(text: string, env: NodeJS.ProcessEnv = {}): string {
  // The oldest line in a full byte tail may start halfway through a credential.
  let out = Buffer.byteLength(text) >= 65_533 ? text.slice(text.indexOf('\n') + 1) : text;
  if (Buffer.byteLength(text) >= 65_533 && !text.includes('\n'))
    return '[truncated stderr line omitted]';
  out = redactSecrets(out)
    // File-loaded credentials may have no recognizable value prefix. Omit the
    // remainder of a credential-bearing JSON line, including truncated values.
    .replace(
      /(["'])(?:[a-z0-9_]*(?:token|secret|password|api[_-]?key)[a-z0-9_]*|passphrase|authorization|proxy-authorization|cookie|set-cookie|private[_-]?key|credential)\1\s*:\s*[^\r\n]*/giu,
      '[REDACTED CREDENTIAL FIELD]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED JWT]')
    .replace(/\b[A-Z][A-Z0-9_]*\s*=[^\r\n]*/gu, '[REDACTED ENVIRONMENT]')
    .replace(
      /\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=][^\r\n]*/giu,
      '$1: [REDACTED]',
    )
    .replace(
      /\b(password|passphrase|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|[a-z0-9_]*(?:secret|password|token|api[_-]?key)[a-z0-9_]*)\s*[:=][^\r\n]*/giu,
      '$1: [REDACTED]',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@');
  // A bounded tail can cut through key armor; never retain a partial key block.
  if (
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/u.test(out) ||
    /-----END [A-Z0-9 ]*PRIVATE KEY/u.test(out)
  ) {
    return '[REDACTED PARTIAL PRIVATE KEY]';
  }
  // Substitute environment values last so they cannot erase credential field names.
  const values = Object.entries(env)
    .filter(
      ([name, value]) => value && (value.length >= 4 || /TOKEN|SECRET|PASSWORD|KEY/u.test(name)),
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(REDACTED);
  return out;
}
