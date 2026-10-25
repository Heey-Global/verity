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

// A model picked inside a meeting applies to that meeting only: it outlives minimizing the
// screen, but never changes the chat's own model.
const chosenModels = new Map<string, string>();

export function setMeetingModel(meetingId: string, model: string): void {
  chosenModels.set(meetingId, model);
}

export interface MeetingModelChoice {
  /** The models the project offers, for the picker. */
  models: string[];
  /** The model meeting requests use; `undefined` keeps the session's own model. */
  model: string | undefined;
  /** What the requests actually run on, for the chip. */
  effective: string;
}

export async function meetingModelChoice(
  client: VerityClient,
  sessionId: string,
  meetingId: string,
): Promise<MeetingModelChoice | null> {
  try {
    const session = await client.getSession(sessionId);
    const available = await client.listModels(session.projectId ?? undefined);
    const chosen = chosenModels.get(meetingId);
    // A choice the project no longer offers falls back rather than failing the request.
    const model =
      chosen !== undefined && available.models.includes(chosen)
        ? chosen
        : fasterMeetingModel(session.model, available.models);
    return { models: available.models, model, effective: model ?? session.model };
  } catch {
    // Model discovery must not block a request on an older or temporarily offline server.
    return null;
  }
}

export async function meetingResearchModel(
  client: VerityClient,
  sessionId: string,
  meetingId: string,
): Promise<string | undefined> {
  return (await meetingModelChoice(client, sessionId, meetingId))?.model;
}
