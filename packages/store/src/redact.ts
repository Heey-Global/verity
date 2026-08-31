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
 *  {@link REDACTED}. Anchored on distinctive prefixes / armored blocks to keep
 *  false positives negligible on ordinary transcript text. */
const SECRET_PATTERNS: RegExp[] = [
  // Armored private keys (OpenSSH / PEM RSA / EC / PGP) — match the whole block.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
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

/**
 * Replace any recognized credential in `text` with {@link REDACTED}. Safe to run
 * over a JSON-serialized event payload: token characters never include JSON
 * structural characters (`"`, `{`, `,`), so replacing a token value in-place keeps
 * the surrounding JSON valid. Returns the input unchanged when nothing matches.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
