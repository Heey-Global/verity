import type { STTEvent } from './liveMeetingSTT';

export interface STTTranscriptState {
  snapshot: string | null;
  segments: Array<{ key: number; end: number; text: string; final: boolean }>;
}

export const emptySTTTranscript: STTTranscriptState = { snapshot: null, segments: [] };

/** Final Apple results replace their volatile span; FluidAudio sends whole-text snapshots. */
export function applySTTEvent(state: STTTranscriptState, event: STTEvent): STTTranscriptState {
  if (event.kind === 'snapshot') return { snapshot: event.text, segments: [] };
  if (event.kind !== 'segment') return state;
  const key = Math.round(event.start * 1000);
  const segments = state.segments.filter(
    (segment) =>
      segment.key !== key &&
      (segment.final || segment.end <= event.start || segment.key / 1000 >= event.end),
  );
  segments.push({ key, end: event.end, text: event.text, final: event.final });
  segments.sort((a, b) => a.key - b.key);
  return { snapshot: null, segments };
}

export function transcriptText(state: STTTranscriptState): string {
  if (state.snapshot !== null) return state.snapshot;
  // Apple can open a result with the punctuation that ends the previous one; joined
  // with a space it showed up as a stray ". " at the start of the next line.
  return state.segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .reduce(
      (text, part) => (!text ? part : /^[.,!?;:…]/u.test(part) ? text + part : `${text} ${part}`),
      '',
    );
}
