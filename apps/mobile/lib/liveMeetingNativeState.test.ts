import { emptyNativeMeetingState, reduceNativeMeetingEvent } from './liveMeetingNativeState';
import { transcriptText } from './liveMeetingSTTTranscript';
import type { STTEvent } from './liveMeetingSTT';

describe('durable native meeting event state', () => {
  it('replays each native sequence once and accepts gaps left by snapshot compaction', () => {
    const snapshot: STTEvent = { kind: 'snapshot', text: 'First sentence.', final: false };
    const first = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, snapshot);
    const duplicate = reduceNativeMeetingEvent(first, 1, {
      ...snapshot,
      text: 'This must not overwrite saved content.',
    });
    expect(duplicate).toBe(first);
    const next = reduceNativeMeetingEvent(duplicate, 12, {
      ...snapshot,
      text: 'First sentence. Second sentence.',
    });
    expect(transcriptText(next.transcript)).toBe('First sentence. Second sentence.');
    expect(next.sequence).toBe(12);
    expect(reduceNativeMeetingEvent(next, 2, snapshot)).toBe(next);
  });

  it('retains earlier Apple ranges across a saved checkpoint and later sequence gaps', () => {
    let state = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, {
      kind: 'segment',
      text: 'First sentence.',
      final: true,
      start: 0,
      end: 2,
    });
    state = reduceNativeMeetingEvent(state, 5, {
      kind: 'segment',
      text: 'Sec',
      final: false,
      start: 3,
      end: 4,
    });
    // The SQLite checkpoint is JSON, not a screen's in-memory transcript reducer.
    state = JSON.parse(JSON.stringify(state)) as typeof state;
    state = reduceNativeMeetingEvent(state, 9, {
      kind: 'segment',
      text: 'Second sentence.',
      final: true,
      start: 3.1,
      end: 5,
    });
    expect(transcriptText(state.transcript)).toBe('First sentence. Second sentence.');
    expect(state.words.map((word) => word.text)).toEqual(['First sentence.', 'Second sentence.']);
    expect(state.transcript.segments).toHaveLength(2);
  });

  it('filters invalid word ranges and does not duplicate native words', () => {
    const words = [
      { text: 'valid', start: 1, end: 2 },
      { text: 'valid', start: 1, end: 2 },
      { text: '', start: 2, end: 3 },
      { text: 'backwards', start: 4, end: 3 },
      { text: 'negative', start: -1, end: 1 },
      { text: 'nonfinite', start: 1, end: Number.POSITIVE_INFINITY },
    ];
    const first = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, { kind: 'words', words });
    const second = reduceNativeMeetingEvent(first, 2, { kind: 'words', words });
    expect(second.words).toEqual([{ text: 'valid', start: 1, end: 2 }]);
    expect(first.words).toHaveLength(1);
  });

  it('validates speaker identities for the selected participant group', () => {
    const event: STTEvent = { kind: 'speaker', speaker: 7, start: 2, end: 3 };
    expect(reduceNativeMeetingEvent(emptyNativeMeetingState, 1, event, 4).turns).toEqual([]);
    const largeGroup = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, event, 10);
    expect(largeGroup.turns).toEqual([{ speaker: 7, start: 2, end: 3 }]);
    let state = reduceNativeMeetingEvent(largeGroup, 2, event, 10);
    for (const [index, bad] of [
      { ...event, speaker: -1 },
      { ...event, speaker: 1.5 },
      { ...event, speaker: 10 },
      { ...event, start: Number.NaN },
      { ...event, end: 1 },
    ].entries())
      state = reduceNativeMeetingEvent(state, index + 3, bad, 10);
    expect(state.turns).toEqual(largeGroup.turns);
  });

  it('persists pause, interruption evidence and a native end with original timestamps', () => {
    let state = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, {
      kind: 'status',
      state: 'listening',
      recordedAt: 1000,
    });
    state = reduceNativeMeetingEvent(state, 2, {
      kind: 'gap',
      at: 14,
      message: 'A call interrupted the microphone.',
      recordedAt: 2000,
    });
    state = reduceNativeMeetingEvent(state, 3, {
      kind: 'status',
      state: 'paused',
      recordedAt: 2100,
    });
    expect(state.captureStatus).toBe('paused');
    expect(state.terminal).toBeUndefined();
    expect(state.gaps).toEqual([{ at: 14, message: 'A call interrupted the microphone.' }]);
    state = reduceNativeMeetingEvent(state, 4, {
      kind: 'status',
      state: 'stopped',
      recordedAt: 3000,
    });
    expect(state.terminal).toBe('ended');
    expect(state.endedAt).toBe(3000);
    expect(state.recordedAt).toBe(3000);
  });

  it('preserves unrelated state when health updates or speaker inference fail', () => {
    const state = reduceNativeMeetingEvent(emptyNativeMeetingState, 1, {
      kind: 'snapshot',
      text: 'Saved words.',
      final: false,
      recordedAt: 1000,
    });
    const next = reduceNativeMeetingEvent(state, 2, {
      kind: 'speaker-status',
      state: 'unavailable',
      message: 'Device is hot.',
    });
    expect(next.transcript).toBe(state.transcript);
    expect(next.words).toBe(state.words);
    expect(next.turns).toBe(state.turns);
    expect(next.captureStatus).toBe(state.captureStatus);
    expect(next.terminal).toBeUndefined();
    expect(next.recordedAt).toBe(1000);
    expect(state.sequence).toBe(1);
  });

  it.each([0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid durable sequence %s',
    (sequence) => {
      expect(() =>
        reduceNativeMeetingEvent(emptyNativeMeetingState, sequence, {
          kind: 'status',
          state: 'listening',
        }),
      ).toThrow('Invalid native sequence');
    },
  );
});
