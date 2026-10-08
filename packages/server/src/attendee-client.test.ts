import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeAttendeeTranscript, verifyAttendeeSignature } from './attendee-client.js';

describe('Attendee transcript ingestion', () => {
  it('verifies sorted JSON signatures and rejects altered content', () => {
    const secret = Buffer.alloc(32, 17).toString('base64');
    const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update('{"a":{"b":2,"z":1},"text":"Grüße"}')
      .digest('base64');
    const payload = { a: { z: 1, b: 2 }, text: 'Grüße' };
    expect(verifyAttendeeSignature(payload, signature, secret)).toBe(true);
    expect(verifyAttendeeSignature({ ...payload, text: 'altered' }, signature, secret)).toBe(false);
    expect(verifyAttendeeSignature(payload, 'invalid', secret)).toBe(false);
  });

  it('replaces corrected snapshots while keeping speaker identities stable', () => {
    const identities: Record<string, number> = {};
    const first = {
      speaker_uuid: 'alice',
      speaker_name: 'Alice',
      timestamp_ms: 1000,
      duration_ms: 500,
      transcription: { transcript: 'old' },
    };
    const second = {
      ...first,
      speaker_uuid: 'bob',
      speaker_name: 'Bob',
      timestamp_ms: 2000,
      transcription: { transcript: 'second' },
    };
    const original = normalizeAttendeeTranscript([second, first], identities, first.timestamp_ms);
    const corrected = normalizeAttendeeTranscript(
      [{ ...second, transcription: { transcript: 'corrected' } }],
      identities,
      first.timestamp_ms,
    );
    expect(original.transcript).toBe('old\nsecond');
    expect(corrected.transcript).toBe('corrected');
    expect(corrected.speakerTurns[0]?.speaker).toBe(original.speakerTurns[1]?.speaker);
    expect(corrected.timedWords[0]?.text).toBe('corrected');
    expect(corrected.speakerTurns[0]?.start).toBe(original.speakerTurns[1]?.start);
  });
});
