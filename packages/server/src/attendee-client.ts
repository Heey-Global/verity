import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const ATTENDEE_WEBHOOK_PATH = '/webhooks/attendee';
export const attendeeUtteranceSchema = z.object({
  speaker_name: z.string().nullable().optional(),
  speaker_uuid: z.string(),
  timestamp_ms: z.number().finite().nonnegative(),
  duration_ms: z.number().finite().nonnegative(),
  transcription: z.object({ transcript: z.string().max(1_000_000) }),
});
export type AttendeeUtterance = z.infer<typeof attendeeUtteranceSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function verifyAttendeeSignature(
  payload: unknown,
  signature: string,
  secret: string,
): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret) || !/^[A-Za-z0-9+/]{43}=$/.test(signature))
    return false;
  const key = Buffer.from(secret, 'base64');
  if (key.length < 16 || key.toString('base64') !== secret) return false;
  const expected = createHmac('sha256', key).update(canonical(payload), 'utf8').digest();
  const actual = Buffer.from(signature, 'base64');
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

/** Full snapshots replace earlier text, so corrected or removed utterances cannot linger. */
export function normalizeAttendeeTranscript(
  utterances: AttendeeUtterance[],
  identities: Record<string, number>,
  timeOriginMs?: number,
) {
  const speakerNames: Record<string, string> = {};
  const speakerTurns: Array<{ speaker: number; start: number; end: number }> = [];
  const timedWords: Array<{ text: string; start: number; end: number }> = [];
  const sorted = [...utterances].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const startMs = timeOriginMs ?? sorted[0]?.timestamp_ms ?? 0;
  const texts: string[] = [];
  for (const utterance of sorted) {
    if (!utterance.transcription.transcript.trim()) continue;
    const speaker = (identities[utterance.speaker_uuid] ??=
      Math.max(-1, ...Object.values(identities)) + 1);
    if (utterance.speaker_name) speakerNames[String(speaker)] = utterance.speaker_name;
    // Late provider segments must not invalidate saved speaker correction ranges.
    const start = Math.max(0, (utterance.timestamp_ms - startMs) / 1000);
    const end = start + utterance.duration_ms / 1000;
    if (end > start) speakerTurns.push({ speaker, start, end });
    // Segment timings preserve speaker attribution without inventing word-level timing.
    timedWords.push({
      text: utterance.transcription.transcript,
      start,
      end: Math.max(end, start + 0.001),
    });
    texts.push(utterance.transcription.transcript);
  }
  return { transcript: texts.join('\n'), speakerNames, speakerTurns, timedWords };
}

export class AttendeeRequestRejected extends Error {
  constructor(readonly status: number) {
    super(`Attendee request rejected (${status})`);
  }
}

export class AttendeeClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://app.attendee.dev/api/v1/${path}`, {
      method,
      redirect: 'error',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    // Never propagate provider response bodies or credentials into app errors/logs.
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && response.status !== 408)
        throw new AttendeeRequestRejected(response.status);
      throw new Error(`Attendee request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  async transcript(botId: string): Promise<AttendeeUtterance[]> {
    return z
      .array(attendeeUtteranceSchema)
      .parse(await this.request(`bots/${encodeURIComponent(botId)}/transcript`));
  }
}
