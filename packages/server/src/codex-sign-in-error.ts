/**
 * What a Codex credential provider throws when the SIGN-IN is what failed: the
 * OAuth refresh for the login the gateway holds was rejected, or the stored login
 * material is unusable as it stands — as opposed to the control channel, the
 * network, or anything else on the way.
 *
 * NOT thrown when the gateway simply holds no login. That answers `undefined` and
 * lands in `no-credential`, which is a setup state rather than a refusal. The
 * split matters downstream: a refusal presupposes a login to refuse, which is why
 * `attention.ts` can offer "sign in again" for one and not the other.
 *
 * The distinction is the whole point: everything else the probe can hit is
 * transient and fixes itself, and this one does not fix itself at all. Somebody
 * has to sign in again, and until they do the same credential is also refused to
 * every sandbox's Codex egress — so the meter being stale is the smallest of the
 * consequences, and the only one visible without this.
 *
 * This module imports nothing, and exists so that none of the modules that speak
 * about a refused Codex sign-in has to import another one to do it. Four do: the
 * credential authority raises the verdict, the gateway control channel forwards
 * it as one flag, the usage probe turns it into a health state, and the OAuth
 * egress gateway answers with it. Declaring these classes in any one of them
 * makes that module a dependency of the other three — the transport loading the
 * OAuth authority to name an error, the probe loading the transport — for a
 * vocabulary that is three lines of state. So they live here instead.
 *
 * Note that the two classes below are siblings rather than parent and child, and
 * so only the credential provider the probe actually uses — the one reading
 * through the gateway control socket, which re-raises a rejected read as a
 * `CodexSignInUnusableError` — reports `sign-in-rejected`. A provider wired
 * straight to `CodexCredentialAuthority.resolve()` throws the other class and
 * reads as a plain failure. That is deliberate: most of what `resolve()` throws
 * carries `signInRejected: false`, so making it a subclass would turn every
 * unreachable token endpoint into a refused sign-in.
 */
export class CodexSignInUnusableError extends Error {
  constructor(message = 'Codex sign-in could not be used', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CodexSignInUnusableError';
  }
}

/**
 * The stored Codex login could not be turned into a usable access token.
 *
 * `signInRejected` separates the failures a new sign-in actually fixes — a stored
 * login that is unusable as written, a refresh the token endpoint turned down —
 * from the ones that would outlast one: the endpoint being unreachable, or
 * answering in a shape this Server does not understand. Only the first may reach
 * the operator as "sign in to Codex again"; sending them through an OAuth flow
 * that changes nothing is worse than saying nothing, because it looks like a fix.
 *
 * Keep every `message` free of text this Server did not choose. The gateway logs
 * it verbatim to its own stderr (`readCodexAccessToken` in
 * `agent-gateway-runtime.ts`) as the only surviving record of a failure the
 * control socket deliberately strips — so a fixed sentence is safe and an HTTP
 * status is too, while an account id or a quoted OAuth body would be written to a
 * log on the strength of a decision made in that other file.
 */
export class CodexCredentialUnavailableError extends Error {
  readonly signInRejected: boolean;

  constructor(message: string, options?: ErrorOptions & { signInRejected?: boolean }) {
    super(message, options);
    this.name = 'CodexCredentialUnavailableError';
    this.signInRejected = options?.signInRejected ?? false;
  }
}
