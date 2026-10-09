import { applySTTEvent, emptySTTTranscript, transcriptText } from './liveMeetingSTTTranscript';

describe('live STT transcript', () => {
  it('replaces a volatile Apple span when its final result arrives', () => {
    const volatile = applySTTEvent(emptySTTTranscript, {
      kind: 'segment',
      text: 'Very',
      final: false,
      start: 1,
      end: 2,
    });
    const final = applySTTEvent(volatile, {
      kind: 'segment',
      text: 'Verity',
      final: true,
      start: 1.1,
      end: 2.2,
    });
    expect(transcriptText(final)).toBe('Verity');
    expect(final.segments).toHaveLength(1);
  });

  // Apple can start a result with the punctuation closing the previous one; joined
  // with a space it later surfaced as a line reading ". Das wäre ja super".
  it('attaches leading punctuation of a result to the previous one', () => {
    const first = applySTTEvent(emptySTTTranscript, {
      kind: 'segment',
      text: 'ob das alles erkennt',
      final: true,
      start: 0,
      end: 2,
    });
    const second = applySTTEvent(first, {
      kind: 'segment',
      text: '. Das wäre super ',
      final: true,
      start: 2,
      end: 4,
    });
    expect(transcriptText(second)).toBe('ob das alles erkennt. Das wäre super');
  });

  it('replaces the running FluidAudio transcript with its final snapshot', () => {
    const running = applySTTEvent(emptySTTTranscript, {
      kind: 'snapshot',
      text: 'The meet',
      final: false,
    });
    const final = applySTTEvent(running, {
      kind: 'snapshot',
      text: 'The meeting',
      final: true,
    });
    expect(transcriptText(final)).toBe('The meeting');
  });
});
