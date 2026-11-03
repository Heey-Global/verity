/**
 * What a tap on a calendar meeting notification asks the floating meeting card to show.
 * The card is mounted on every screen, so it owns these prompts; a request made before it
 * mounts (a cold start from the notification) waits here until it subscribes.
 */
export type MeetingPrompt =
  { kind: 'upcoming'; eventKey: string } | { kind: 'started'; meetingId: string };

let pending: MeetingPrompt | null = null;
const listeners = new Set<(prompt: MeetingPrompt) => void>();

export function requestMeetingPrompt(prompt: MeetingPrompt): void {
  if (listeners.size === 0) {
    pending = prompt;
    return;
  }
  for (const listener of listeners) listener(prompt);
}

/** Receives the waiting request at once and every later one; each is delivered once. */
export function subscribeMeetingPrompt(listener: (prompt: MeetingPrompt) => void): () => void {
  listeners.add(listener);
  if (pending) {
    const prompt = pending;
    pending = null;
    listener(prompt);
  }
  return () => {
    listeners.delete(listener);
  };
}
