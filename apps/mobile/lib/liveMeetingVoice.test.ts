import { VoiceMeetingCommandDetector, voiceMeetingCommands } from './liveMeetingVoice';

afterEach(() => jest.useRealTimers());

const utterances = (transcript: string) =>
  voiceMeetingCommands(transcript).map((command) => command.utterance);

// Whether a sentence is a request is the server model's call. If the recorder judged phrasing
// here again, every language and idiom it does not list would silently never reach Verity.
test('passes on every sentence that names Verity, in any language, without judging it', () => {
  expect(
    utterances(
      'Wir starten. Verity, was meinst du dazu? Verity, qu’en penses-tu ? ' +
        'We tested how Verity checks invoices. Verity recherchiert gerade die Preise.',
    ),
  ).toEqual([
    'Verity, was meinst du dazu?',
    'Verity, qu’en penses-tu ?',
    'We tested how Verity checks invoices.',
    'Verity recherchiert gerade die Preise.',
  ]);
  expect(utterances('Das Budget steht. Wir reden morgen weiter.')).toEqual([]);
});

// The words before the name decide whether it is addressed ("we asked Verity" vs "Verity, …").
test('keeps the whole sentence around the name, bounded for run-on transcripts', () => {
  expect(utterances('Kurz noch: kannst du, Verity, die Preise prüfen?')).toEqual([
    'Kurz noch: kannst du, Verity, die Preise prüfen?',
  ]);
  const runOn = `${'und dann '.repeat(40)}Verity prüf das`;
  const [command] = voiceMeetingCommands(runOn);
  expect(command!.utterance.length).toBeLessThanOrEqual(200 + 'Verity prüf das'.length);
  expect(command!.utterance.endsWith('Verity prüf das')).toBe(true);
  expect(runOn.slice(command!.start)).toBe(command!.utterance);
});

test('does not end a sentence at the dots inside names, numbers and abbreviations', () => {
  expect(
    utterances('Verity, prüf z.B. bei Dr. Müller, ob Node.js 3.5 Lizenzen braucht. Weiter.'),
  ).toEqual(['Verity, prüf z.B. bei Dr. Müller, ob Node.js 3.5 Lizenzen braucht.']);
  expect(utterances('Verity, research Node.js compatibility.')).toEqual([
    'Verity, research Node.js compatibility.',
  ]);
  expect(utterances('Verity, research Prof. Smith and Mrs. Jones.')).toEqual([
    'Verity, research Prof. Smith and Mrs. Jones.',
  ]);
});

test('joins a name spoken on its own to the sentence that follows', () => {
  expect(utterances('Verity. Recherchier mal den Preis.')).toEqual([
    'Verity. Recherchier mal den Preis.',
  ]);
  expect(voiceMeetingCommands('Verity.')).toEqual([]);
});

test('sends one utterance when the name comes twice in one sentence', () => {
  expect(
    utterances('Verity research the hosting costs Verity what do you think about the launch'),
  ).toEqual(['Verity research the hosting costs Verity what do you think about the launch']);
});

test('caps a sentence that never ends and marks it complete', () => {
  const [command] = voiceMeetingCommands(`Verity ${'bla '.repeat(300)}`);
  expect(command!.utterance.length).toBeLessThanOrEqual(600);
  expect(command!.complete).toBe(true);
});

test('waits for a stable snapshot and sends a revised command only once', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, recherchiere den Termin', false);
  jest.advanceTimersByTime(2000);
  detector.observe('Verity, recherchiere den Termin im Vertrag', false);
  detector.observe('Verity, recherchiere den Termin im Vertrag', false);
  jest.advanceTimersByTime(2999);
  expect(dispatch).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ utterance: 'Verity, recherchiere den Termin im Vertrag' }),
  );
  detector.observe('Verity, recherchiere den Termin im Vertrag.', true);
  detector.observe('Heute: Verity, recherchiere den Termin im Vertrag.', true);
  detector.observe('Heute: Verity, recherchiere den Termin im Vertrag für Projekt A.', true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  detector.observe(
    'Heute: Verity, recherchiere den Termin im Vertrag. Verity, prüfe die Kosten.',
    true,
  );
  expect(dispatch).toHaveBeenCalledTimes(2);
  detector.stop();
});

test('dispatches a completed spoken sentence without waiting for a final snapshot', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, was hältst du von diesem Vorschlag?', false);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ complete: true }));
  detector.stop();
});

test('dispatches two completed requests from one transcript update in order', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline. Verity, check the budget.', false);
  expect(dispatch.mock.calls.map(([command]) => command.utterance)).toEqual([
    'Verity, research the deadline.',
    'Verity, check the budget.',
  ]);
  detector.stop();
});

test('does not resend a command when earlier wake-word text is revised', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline.', true);
  detector.observe('Verity, can you research the deadline.', true);
  detector.observe('Verity, research the delivery date.', true);
  detector.observe('Verity, research the deadline.', true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  detector.observe('Verity, research the deadline. Verity, research the deadline.', true);
  expect(dispatch).toHaveBeenCalledTimes(2);
  detector.stop();
});

test('does not mistake a new earlier mention for an already sent request', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline.', true);
  detector.observe('Someone mentioned Verity earlier. Verity, research the deadline.', true);
  expect(dispatch.mock.calls.map(([command]) => command.utterance)).toEqual([
    'Verity, research the deadline.',
    'Someone mentioned Verity earlier.',
  ]);
});

test('does not resend a stable partial after punctuation is added', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research 2026', false);
  jest.advanceTimersByTime(3000);
  detector.observe('Verity, research 2026.', true);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('sends a new request after an earlier recognized request disappears', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline.', true);
  detector.observe('The deadline is settled.', true);
  detector.observe('The deadline is settled. Verity, check the budget.', true);
  expect(dispatch.mock.calls.map(([command]) => command.utterance)).toEqual([
    'Verity, research the deadline.',
    'Verity, check the budget.',
  ]);
});

test('keeps short sentence endings separate in a batched transcript', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the UK. Verity, check the budget.', false);
  expect(dispatch.mock.calls.map(([command]) => command.utterance)).toEqual([
    'Verity, research the UK.',
    'Verity, check the budget.',
  ]);
});

test('does not send an unfinished snapshot after capture stops', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, was hältst du von diesem Vorschlag', false);
  detector.stop();
  jest.advanceTimersByTime(3000);
  expect(dispatch).not.toHaveBeenCalled();
});

test('pausing cancels a pending command and ignores its old transcript after resume', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  const text = 'Verity, recherchiere den Termin im Vertrag';
  detector.observe(text, false);
  detector.pause(text);
  jest.advanceTimersByTime(3000);
  detector.observe(`${text}.`, true);
  expect(dispatch).not.toHaveBeenCalled();
  detector.observe(`${text}. Verity, prüfe den neuen Plan.`, true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ utterance: 'Verity, prüfe den neuen Plan.' }),
  );
});
