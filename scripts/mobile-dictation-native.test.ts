import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('native Apple dictation preparation', () => {
  it('checks ownership after format negotiation before replacing the audio stream', () => {
    const source = readFileSync('apps/mobile/native/VerityLiveSTT.swift', 'utf8');
    const method = source.slice(
      source.indexOf('private func startAppleMicrophone('),
      source.indexOf('private func emitAppleResult('),
    );
    const negotiation = method.indexOf('await SpeechAnalyzer.bestAvailableAudioFormat(');
    const streamMutation = method.indexOf('analyzerInput = continuation');
    expect(negotiation).toBeGreaterThanOrEqual(0);
    expect(streamMutation).toBeGreaterThan(negotiation);
    // A cancelled preparation can otherwise overwrite the next recording's stream.
    expect(method.slice(negotiation, streamMutation)).toMatch(/try ensureActive\(generation\)/);
  });
});
