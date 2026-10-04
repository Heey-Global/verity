import type { IntegrationStore } from '@verity/store';
import { ControlPlaneSessionToolError } from './session-handoff-tool.js';
async function safeRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new ControlPlaneSessionToolError('Matrix diagnostic evidence unavailable');
  }
}
export async function readMatrixDiagnosticSnapshot(
  store: IntegrationStore,
  authorizeProject: (projectId: string) => Promise<void>,
  projectId: string,
  selectedEvent?: { accountId: string; sourceId: string; eventId: string },
) {
  await authorizeProject(projectId);
  const sources = await safeRead(() => store.listSources(projectId));
  let event = null;
  let currentSources = null;
  if (selectedEvent) {
    const binding = sources.find(
      (source) =>
        source.accountId === selectedEvent.accountId && source.sourceId === selectedEvent.sourceId,
    );
    if (!binding?.activatedAt) throw new ControlPlaneSessionToolError('target room unavailable');
    const stored = await safeRead(() =>
      store.getEvent(selectedEvent.accountId, selectedEvent.sourceId, selectedEvent.eventId),
    );
    event =
      stored && stored.occurredAt >= binding.activatedAt
        ? {
            stored: true,
            kind: stored.kind,
            targetEventId: stored.targetEventId,
            occurredAt: stored.occurredAt.toISOString(),
          }
        : { stored: false };
    currentSources = await safeRead(() => store.listSources(projectId));
    if (
      !currentSources.some(
        (source) =>
          source.accountId === selectedEvent.accountId &&
          source.sourceId === selectedEvent.sourceId &&
          source.activatedAt?.getTime() === binding.activatedAt?.getTime(),
      )
    )
      throw new ControlPlaneSessionToolError('target room unavailable');
  }
  currentSources ??= await safeRead(() => store.listSources(projectId));
  const retained = sources.filter((source) =>
    currentSources.some(
      (current) =>
        current.accountId === source.accountId &&
        current.sourceId === source.sourceId &&
        current.activatedAt?.getTime() === source.activatedAt?.getTime(),
    ),
  );
  retained.sort(
    (left, right) =>
      Number(right.importDiagnostics.length > 0) - Number(left.importDiagnostics.length > 0),
  );
  await authorizeProject(projectId);
  return {
    projectId,
    truncated: retained.length > 20,
    event,
    sources: retained.slice(0, 20).map((source) => ({
      accountId: source.accountId,
      sourceId: source.sourceId,
      status: source.status,
      lastIngestedAt: source.lastIngestedAt?.toISOString() ?? null,
      importDiagnostics: source.importDiagnostics.filter(
        (diagnostic) =>
          source.activatedAt !== null && new Date(diagnostic.occurredAt) >= source.activatedAt,
      ),
      importDiagnosticsTruncated: source.importDiagnosticsTruncated,
      importDiagnosticsReportedAt: source.importDiagnosticsReportedAt?.toISOString() ?? null,
    })),
  };
}
