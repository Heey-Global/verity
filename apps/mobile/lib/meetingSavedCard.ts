export interface SavedMeetingCard {
  title: string;
  link: string;
  sessionId?: string;
  meetingId?: string;
  durationMinutes?: number;
  people?: number;
  answers?: number;
  notes?: number;
}

/** Recognize the server's complete notice, never arbitrary links in an answer. */
export function meetingSavedCard(text: string): SavedMeetingCard | null {
  const match =
    /^Meeting saved to the knowledge base: \[([^\n]*)\]\(([^\n]+)\)(?:\n<!-- verity-meeting: (.+) -->)?$/.exec(
      text,
    );
  if (!match) return null;
  const base = { title: match[1]!, link: match[2]! };
  if (!match[3]) return base;
  try {
    const value: unknown = JSON.parse(match[3]);
    if (!value || typeof value !== 'object') return base;
    const data = value as Record<string, unknown>;
    if (typeof data.sessionId !== 'string' || typeof data.meetingId !== 'string') return base;
    const count = (key: string) =>
      typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0
        ? data[key]
        : undefined;
    return {
      ...base,
      sessionId: data.sessionId,
      meetingId: data.meetingId,
      durationMinutes: count('durationMinutes'),
      people: count('people'),
      answers: count('answers'),
      notes: count('notes'),
    };
  } catch {
    return base;
  }
}
