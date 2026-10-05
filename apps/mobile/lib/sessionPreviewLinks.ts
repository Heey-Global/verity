import type { LocalPreviewShare, PublicPreviewShare } from '@verity/mobile';

/** A session's preview link; `url` is null while a public share has no origin yet. */
export interface SessionPreviewLink {
  sessionId: string;
  url: string | null;
  expiresAt: number;
}

/** Project id → that project's preview links from one source. */
export type ProjectPreviewLinks = ReadonlyMap<string, readonly SessionPreviewLink[]>;

export function publicPreviewLinks(shares: readonly PublicPreviewShare[]): SessionPreviewLink[] {
  return shares.flatMap((share) =>
    share.sessionId && share.targetKind === 'static-folder' && share.state === 'active'
      ? [
          {
            sessionId: share.sessionId,
            url: share.publicOrigin,
            expiresAt: new Date(share.expiresAt).getTime(),
          },
        ]
      : [],
  );
}

export function localPreviewLinks(shares: readonly LocalPreviewShare[]): SessionPreviewLink[] {
  return shares.map((share) => ({
    sessionId: share.sessionId,
    url: share.url,
    expiresAt: share.expiresAt.getTime(),
  }));
}

/**
 * Fold one poll of a source into its per-project links. A project whose read failed
 * keeps its previous links rather than blanking every project's icons — or, with one
 * project failing on every poll, freezing every other project's links with it.
 * Projects no longer polled drop out.
 */
export function nextProjectPreviewLinks(
  previous: ProjectPreviewLinks,
  projectIds: readonly string[],
  results: readonly PromiseSettledResult<readonly SessionPreviewLink[]>[],
): ProjectPreviewLinks {
  return new Map(
    projectIds.map((projectId, index) => {
      const result = results[index];
      return [
        projectId,
        result?.status === 'fulfilled' ? result.value : (previous.get(projectId) ?? []),
      ];
    }),
  );
}

/**
 * Session id → the URL its preview icon opens. A local link wins over a public one:
 * it stays on the operator's network and asks for no PIN. Expiry is checked here, on
 * every merge, so a link kept from an earlier poll still lapses on time.
 */
export function mergeSessionPreviewUrls(
  publicLinks: ProjectPreviewLinks,
  localLinks: ProjectPreviewLinks,
  now: number,
): Map<string, string | null> {
  const merged = new Map<string, string | null>();
  for (const source of [publicLinks, localLinks]) {
    for (const links of source.values()) {
      for (const link of links) {
        if (link.expiresAt > now && (link.url !== null || !merged.has(link.sessionId)))
          merged.set(link.sessionId, link.url);
      }
    }
  }
  return merged;
}
