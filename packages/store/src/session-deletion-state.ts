/** What a session deletion still owes, kept so a retry finishes what an earlier attempt began. */
export interface SessionDeletionState {
  session?: { sessionId?: string; projectId?: string | null; worktree?: string };
  previewIds?: string[];
  managed?: { sessionId: string; projectId: string | null; instanceIds: string[] };
  terminationConfirmed?: boolean;
  legacyArtifactsPurged?: boolean;
  artifactBindings?: { backend: string; backendSessionId: string }[];
  purgedArtifactBindings?: { backend: string; backendSessionId: string }[];
}

/** Ownership is monotonic even when an older Server writes its retry snapshot. */
export function mergeSessionDeletionState(
  current: SessionDeletionState,
  next: SessionDeletionState,
): SessionDeletionState {
  const managed = current.managed ?? next.managed;
  const session = current.session ?? next.session;
  return {
    ...current,
    ...next,
    artifactBindings: [
      ...new Map(
        [...(current.artifactBindings ?? []), ...(next.artifactBindings ?? [])].map((binding) => [
          JSON.stringify([binding.backend, binding.backendSessionId]),
          binding,
        ]),
      ).values(),
    ],
    purgedArtifactBindings: [
      ...new Map(
        [...(current.purgedArtifactBindings ?? []), ...(next.purgedArtifactBindings ?? [])].map(
          (binding) => [JSON.stringify([binding.backend, binding.backendSessionId]), binding],
        ),
      ).values(),
    ],
    ...(session === undefined ? {} : { session }),
    previewIds: [...new Set([...(current.previewIds ?? []), ...(next.previewIds ?? [])])],
    ...(managed === undefined
      ? {}
      : {
          managed: {
            ...managed,
            projectId: current.managed?.projectId ?? next.managed?.projectId ?? null,
            instanceIds: [
              ...new Set([
                ...(current.managed?.instanceIds ?? []),
                ...(next.managed?.instanceIds ?? []),
              ]),
            ],
          },
        }),
    ...(current.legacyArtifactsPurged || next.legacyArtifactsPurged
      ? { legacyArtifactsPurged: true }
      : {}),
    ...(current.terminationConfirmed || next.terminationConfirmed
      ? { terminationConfirmed: true }
      : {}),
  };
}
