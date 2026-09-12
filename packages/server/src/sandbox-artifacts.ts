/**
 * The sibling artifacts a Server release publishes alongside itself, and the
 * last-resort refs to fall back on when neither the release pin nor the
 * published-latest channel can be resolved.
 *
 * Its own module because both composition roots need it and neither can own it:
 * `main.ts` imports `embedded.ts`, so a constant declared in `main.ts` is not
 * reachable from the embedded default that has to agree with it, and two
 * literals that must stay equal are exactly how the previous pair rotted apart.
 */

export const SANDBOX_IMAGE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox';
export const TOOLKIT_FEATURE_REPO = 'ghcr.io/heey-global/verity/verity-sandbox-toolkit';

/**
 * The release whose artifacts the fallbacks name. One version for both, because
 * one backend release publishes the Server, the sandbox image and the toolkit
 * Feature together — `releasePinnedRef` pins all of them to the same
 * `VERITY_SERVER_VERSION`, and `release.yml` tags the toolkit with it.
 *
 * The previous fallbacks — a v16-era sandbox digest and toolkit Feature 1.14.9 —
 * both 404 on ghcr.io, and had for long enough that nobody noticed: the fallback
 * is reached only on a cold start that cannot resolve the published tag, so a ref
 * naming a deleted artifact is indistinguishable from a working one until it is
 * the only thing left to try. Resetting the release train to 0.x deleted the
 * sandbox packages outright; these name what the reset train publishes first.
 *
 * Kept at the first release rather than chased forward deliberately: the fallback
 * must not follow the pin, or a release whose sibling publish failed would fall
 * back onto the same missing tag.
 */
export const FALLBACK_ARTIFACT_VERSION = '0.1.0';

/**
 * A tag rather than a digest, unavoidably: a digest is not knowable until the
 * build that produces it has run. Behind a resolver the weaker ref is confined
 * to the cold-start path — `createPublishedDefaultResolver` treats the fallback
 * as "at best a tag" and prefers any digest it has actually resolved over it.
 *
 * An embedder that omits a resolver gets no such preference: `embedded.ts` uses
 * this ref verbatim, so a mutable tag is what it pulls. That is weaker than the
 * digest it replaces, and deliberately so — the digest named a deleted image, so
 * it pinned nothing it could still pull. An embedder that wants the stronger pin
 * passes its own digest as `defaultProjectImage`.
 */
export const DEFAULT_SANDBOX_IMAGE_FALLBACK = `${SANDBOX_IMAGE_REPO}:v${FALLBACK_ARTIFACT_VERSION}`;
export const DEFAULT_TOOLKIT_FEATURE_FALLBACK = `${TOOLKIT_FEATURE_REPO}:${FALLBACK_ARTIFACT_VERSION}`;
