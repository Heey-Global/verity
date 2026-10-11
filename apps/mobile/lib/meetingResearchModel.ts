import type { VerityClient } from '@verity/mobile';

/** Choose only a model advertised for this project and keep the same backend. */
export function fasterMeetingModel(current: string, models: readonly string[]): string | undefined {
  const candidate = current.startsWith('codex/')
    ? 'codex/gpt-6-luna'
    : /^(?:claude-opus-|claude-fable-)/u.test(current)
      ? 'claude-sonnet-5-5'
      : undefined;
  return candidate && candidate !== current && models.includes(candidate) ? candidate : undefined;
}

export async function meetingResearchModel(
  client: VerityClient,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const session = await client.getSession(sessionId);
    const available = await client.listModels(session.projectId ?? undefined);
    return fasterMeetingModel(session.model, available.models);
  } catch {
    // Model discovery must not block a request on an older or temporarily offline server.
    return undefined;
  }
}
