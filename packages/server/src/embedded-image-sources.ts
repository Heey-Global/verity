import type { EmbeddedServerConfig } from './embedded-types.js';
import type { DevcontainerFeatureSource, ProjectImageRefSource } from './provisioner.js';
import { DEFAULT_SANDBOX_IMAGE_FALLBACK } from './sandbox-artifacts.js';
import { pinToolkitFeature, releaseToolkitFeature } from './devcontainer-feature-pin.js';
import {
  rejectLatestImageRef,
  publishedDevcontainerFeatureRef,
  toolkitFeatureRefIsConfigured,
  resolveToolkitFeatureRef,
  readBundledDevcontainerFeature,
} from './embedded-support.js';

export function createEmbeddedDefaultProjectImage(
  config: Pick<EmbeddedServerConfig, 'defaultProjectImage'>,
): ProjectImageRefSource {
  // `main.ts` always passes a resolver, so this is what an embedder that omits
  // one gets. Shared with the last-resort fallback there rather than repeated:
  // the two must name the same artifact, and the pair they replace drifted onto
  // a sandbox image that no longer exists. Note this path is the ref VERBATIM —
  // no resolver sits behind it to prefer a digest it resolved earlier, so an
  // embedder that wants the stronger pin passes its own digest.
  const defaultProjectImageSource = config.defaultProjectImage ?? DEFAULT_SANDBOX_IMAGE_FALLBACK;
  return typeof defaultProjectImageSource === 'function'
    ? // Forward `forceRefresh` so the provision/recreate path can pin the CURRENT
      // digest instead of the poll cache's; the zero-arg update poll passes none.
      async (forceRefresh?: boolean) =>
        rejectLatestImageRef(
          await defaultProjectImageSource(forceRefresh),
          'VERITY_DEFAULT_PROJECT_IMAGE',
        )
    : rejectLatestImageRef(defaultProjectImageSource, 'VERITY_DEFAULT_PROJECT_IMAGE');
}

export function prepareEmbeddedToolkitFeature(
  config: Pick<EmbeddedServerConfig, 'devcontainerFeatureRef' | 'devcontainerFeatureRefConfigured'>,
): () => Extract<DevcontainerFeatureSource, () => unknown> | undefined {
  // Pin the toolkit Feature to the version BAKED into this server image, resolved
  // from GHCR under its BARE semver tag (never the `v`-prefixed visible-version
  // tag, which is not a resolvable Feature manifest — that was the `…:v1.11.6`
  // build failure). Off-server (dev/test) the bundle is absent → published ref.
  const configuredDevcontainerFeatureRef = config.devcontainerFeatureRef;
  // A ref handed over as a plain STRING is configuration by construction —
  // nothing resolved it, a caller wrote it. Only the resolver-function form is
  // ambiguous (`main.ts` uses it for both the operator's value and its own
  // lookup), and only that form has to fall back to reading the environment.
  const devcontainerFeatureRefConfigured =
    config.devcontainerFeatureRefConfigured ??
    (typeof configuredDevcontainerFeatureRef === 'string'
      ? configuredDevcontainerFeatureRef.trim().length > 0
      : toolkitFeatureRefIsConfigured());
  return () => {
    const selectedDevcontainerFeature: DevcontainerFeatureSource | undefined =
      typeof configuredDevcontainerFeatureRef === 'function'
        ? async () =>
            resolveToolkitFeatureRef(
              readBundledDevcontainerFeature(),
              publishedDevcontainerFeatureRef(await configuredDevcontainerFeatureRef()),
              devcontainerFeatureRefConfigured,
            )
        : resolveToolkitFeatureRef(
            readBundledDevcontainerFeature(),
            publishedDevcontainerFeatureRef(configuredDevcontainerFeatureRef),
            devcontainerFeatureRefConfigured,
          );
    return selectedDevcontainerFeature === undefined
      ? undefined
      : async () =>
          pinToolkitFeature(
            releaseToolkitFeature(
              typeof selectedDevcontainerFeature === 'function'
                ? await selectedDevcontainerFeature()
                : selectedDevcontainerFeature,
              process.env.VERITY_BUNDLED_PROTECTED_TOOLKIT_FEATURE,
              devcontainerFeatureRefConfigured,
            ),
          );
  };
}
