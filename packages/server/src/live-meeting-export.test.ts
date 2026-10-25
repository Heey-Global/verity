import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  renderLiveMeetingMarkdown,
  liveMeetingSavedMessage,
  liveMeetingTitle,
  liveMeetingLinkLabel,
  liveMeetingAnswerCount,
  liveMeetingPeopleCount,
} from './live-meeting-export.js';

const meeting = {
  id: 'meeting-1',
  sessionId: 'session-1',
  engine: 'fluid-nemotron',
  startedAt: Date.UTC(2026, 9, 1, 14, 5),
  endedAt: Date.UTC(2026, 9, 1, 14, 47, 10),
  state: 'ended' as const,
  transcript: 'Ship it today. Not before Friday.',
  timedWords: [
    { text: 'Ship it today.', start: 3, end: 5 },
    { text: 'Not before Friday.', start: 70, end: 72 },
  ],
  speakerTurns: [
    { speaker: 0, start: 2, end: 6 },
    { speaker: 1, start: 69, end: 73 },
  ],
  speakerNames: { '0': 'Anna' },
  captureStatus: 'listening',
  revision: 4,
};

describe('renderLiveMeetingMarkdown', () => {
  it('files speakers with their names and meeting times, notes and insights', () => {
    const markdown = renderLiveMeetingMarkdown({
      meeting,
      notes: [
        {
          id: 'n2',
          meetingId: 'meeting-1',
          atSeconds: 71,
          text: 'Friday\n# not a heading',
          revision: 1,
        },
        { id: 'n1', meetingId: 'meeting-1', atSeconds: 4, text: 'Decide ship date', revision: 1 },
        { id: 'n3', meetingId: 'meeting-1', atSeconds: 9, text: '   ', revision: 2 },
      ],
      insights: [
        {
          id: 'i1',
          meetingId: 'meeting-1',
          kind: 'contradiction',
          summary: 'Ship date disagrees',
          evidenceA: 'Ship it today.',
          evidenceB: 'Not before Friday.',
          sourcePath: null,
          createdAt: 2,
        },
      ],
    });
    expect(markdown).toContain('# Live meeting 2026-10-01 14:05 UTC');
    expect(markdown).toContain('- Duration: 42:10');
    expect(markdown).toContain('- Speakers: Anna, Speaker 2');
    expect(markdown).toContain('**Anna** (00:03): Ship it today.');
    expect(markdown).toContain('**Speaker 2** (01:10): Not before Friday.');
    expect(markdown).toContain('- **Possible contradiction:** Ship date disagrees');
    // Notes are in meeting order; a cleared note is gone, and a line break in a note
    // must not open a heading in the filed document.
    expect(markdown).toContain('- (00:04) Decide ship date\n- (01:11) Friday # not a heading');
    expect(markdown).not.toContain('(00:09)');
    expect(markdown).not.toMatch(/^# not a heading/m);
  });

  it('keeps the plain transcript when timed words no longer match it', () => {
    const markdown = renderLiveMeetingMarkdown({
      meeting: { ...meeting, state: 'interrupted', transcript: 'Something else entirely' },
      notes: [],
      insights: [],
    });
    expect(markdown).toContain('## Transcript\n\nSomething else entirely');
    expect(
      renderLiveMeetingMarkdown({
        meeting: { ...meeting, transcript: '# Not a heading' },
        notes: [],
        insights: [],
      }),
    ).toContain('\n\\# Not a heading\n');
    expect(markdown).toContain('the recording was interrupted');
  });

  // The renderer carries a copy of the device's speaker attribution; a fix applied
  // to only one of them would file a transcript that disagrees with the screen.
  it('keeps the speaker attribution in step with the meeting screen', () => {
    const body = (path: string) => {
      const source = readFileSync(join(import.meta.dirname, path), 'utf8');
      return ['resolvedSpeaker', 'reconcileTimedTranscript', 'speakerLines'].map((name) => {
        const start = source.indexOf(`function ${name}(`);
        expect(start).toBeGreaterThanOrEqual(0);
        const lines = source.slice(start, source.indexOf('\n}\n', start)).split('\n');
        // The body starts after the unindented line that closes the signature, which
        // the two files format and type differently.
        return lines.slice(lines.findIndex((line) => /^\S.*\{$/.test(line)) + 1);
      });
    };
    expect(body('live-meeting-export.ts')).toEqual(
      body('../../../apps/mobile/lib/liveMeetingSpeakers.ts'),
    );
  });
});

it('uses the chosen meeting title in the export and saved notice', () => {
  const named = { ...meeting, title: 'Pricing sync' };
  expect(liveMeetingTitle(named)).toBe('Pricing sync');
  expect(renderLiveMeetingMarkdown({ meeting: named, notes: [], insights: [] })).toContain(
    '# Pricing sync',
  );
  const details = {
    sessionId: meeting.sessionId,
    meetingId: meeting.id,
    durationMinutes: 42,
    people: 2,
    notes: 0,
  };
  const notice = liveMeetingSavedMessage('/knowledge/meetings/pricing.md', named.title, details);
  expect(JSON.parse(notice.split('<!-- verity-meeting: ')[1]!.split(' -->')[0]!)).toEqual(details);
});

it('counts completed answers without counting tool progress or duplicate question replies', () => {
  const prompt =
    'Research this point raised during live meeting meeting-1:\n\nWhat costs?\n\nMeeting request reference: request-1\n\nMeeting question reference: question-1';
  expect(
    liveMeetingAnswerCount(
      [
        { t: 'prompt', text: prompt },
        { t: 'text', delta: 'Checking…' },
        { t: 'tool_call' },
        { t: 'result' },
        { t: 'prompt', text: prompt },
        { t: 'text', delta: '€10' },
        { t: 'result' },
        { t: 'prompt', text: prompt },
        { t: 'text', delta: '€10 updated' },
        { t: 'result' },
      ],
      'meeting-1',
    ),
  ).toBe(1);
});

it('keeps title punctuation literal in saved links', () => {
  const title = String.raw`Sync](https://example.com) [Q1] \ files`;
  const label = String.raw`Sync\](https://example.com) \[Q1\] \\ files`;
  expect(liveMeetingLinkLabel(title)).toBe(label);
  expect(liveMeetingSavedMessage('/knowledge/meeting.md', title)).toBe(
    `Meeting saved to the knowledge base: [${label}](/knowledge/meeting.md)`,
  );
});

it('counts resolved people after speaker merges and manual corrections', () => {
  const turns = [
    { speaker: 0, start: 0, end: 1 },
    { speaker: 1, start: 1, end: 2 },
  ];
  expect(liveMeetingPeopleCount({ speakerTurns: turns, speakerMerges: { '1': 0 } })).toBe(1);
  expect(
    liveMeetingPeopleCount({
      speakerTurns: turns,
      speakerMerges: { '1': 0 },
      speakerCorrections: [
        { start: 3, end: 4, speaker: 2 },
        { start: 4, end: 5, speaker: null },
      ],
    }),
  ).toBe(2);
});

it('counts repeated direct questions once across punctuation, prefixes and request IDs', () => {
  const requests = ['What costs?', 'VERITY, research what costs!'];
  const events = requests.flatMap((request, index) => [
    {
      t: 'prompt',
      text: `During live meeting meeting-1, please respond to this request:\n\n${request}\n\nRecent meeting transcript:\ncontext\n\nMeeting request reference: request-${index}`,
    },
    { t: 'text', delta: '€10' },
    { t: 'result' },
  ]);
  expect(liveMeetingAnswerCount(events, 'meeting-1')).toBe(1);
});

it('does not count combined or unfinished retries as completed answers', () => {
  const prompt =
    'During live meeting meeting-1, please respond to this request:\n\nWhat costs?\n\nRecent meeting transcript:\ncontext';
  const answered = [{ t: 'prompt', text: prompt }, { t: 'text', delta: '€10' }, { t: 'result' }];
  expect(liveMeetingAnswerCount(answered, 'meeting-1')).toBe(1);
  expect(liveMeetingAnswerCount([...answered, { t: 'prompt', text: prompt }], 'meeting-1')).toBe(0);
  expect(
    liveMeetingAnswerCount(
      [
        { t: 'prompt', text: prompt },
        { t: 'prompt', text: prompt, steered: true },
        { t: 'text', delta: 'Combined' },
        { t: 'result' },
      ],
      'meeting-1',
    ),
  ).toBe(0);
});
