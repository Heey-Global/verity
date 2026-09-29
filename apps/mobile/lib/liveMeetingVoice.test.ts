import { latestVoiceMeetingCommand, VoiceMeetingCommandDetector } from './liveMeetingVoice';

afterEach(() => jest.useRealTimers());

test('recognizes research and opinion only after the wake word', () => {
  expect(latestVoiceMeetingCommand('Verity, recherchiere mal den Liefertermin.')).toMatchObject({
    kind: 'research',
    request: 'recherchiere mal den Liefertermin',
  });
  expect(latestVoiceMeetingCommand('Verity, was hältst du von diesem Vorschlag?')).toMatchObject({
    kind: 'opinion',
    request: 'was hältst du von diesem Vorschlag',
  });
  expect(latestVoiceMeetingCommand('Recherchiere mal den Liefertermin.')).toBeNull();
  expect(latestVoiceMeetingCommand('Verity, lösche das Projekt.')).toBeNull();
  expect(latestVoiceMeetingCommand('Verity, research Verity pricing.')).toMatchObject({
    kind: 'research',
    request: 'research Verity pricing',
  });
  expect(latestVoiceMeetingCommand('Verity, research Node.js compatibility.')).toMatchObject({
    kind: 'research',
    request: 'research Node.js compatibility',
  });
  expect(
    latestVoiceMeetingCommand('Verity, research the UK. Verity, check the budget.'),
  ).toMatchObject({
    request: 'check the budget',
  });
  expect(latestVoiceMeetingCommand('Verity, recherchiere.')).toBeNull();
});

test('accepts spoken lead-ins and sends a restarted request once', () => {
  // Verbatim from a device transcript whose requests were not recognized.
  const transcript =
    'Verity kannst du mal schauen, wie ein guter Webdesigner heißt. Verity, äh mach mal bitte Research Verity Research Good Web Designers';
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe(transcript, true);
  expect(dispatch.mock.calls.map(([command]) => command.request)).toEqual([
    'kannst du mal schauen, wie ein guter Webdesigner heißt',
    'Research Good Web Designers',
  ]);
  expect(latestVoiceMeetingCommand('Verity, ähm bitte recherchiere den Preis.')).toMatchObject({
    kind: 'research',
  });
  expect(latestVoiceMeetingCommand('Verity, kannst du mal kurz warten.')).toBeNull();
  for (const statement of [
    'Verity, such a good point from Anna.',
    'Verity, researchers found that churn doubled.',
    'Verity, Recherche ergab, dass es teurer wird.',
    'Verity, Google hat das gestern veröffentlicht.',
    'Verity schaut sich dann die Daten an.',
    'Verity guckt automatisch nach.',
    'Verity googlet das.',
    'Verity, Recherche ist fertig.',
  ])
    expect(latestVoiceMeetingCommand(statement)).toBeNull();
  detector.stop();
});

test('recognizes everyday German phrasings, since meetings are transcribed in German', () => {
  for (const [spoken, kind] of [
    ['Verity, was meinst du zu dem Angebot?', 'opinion'],
    ['Verity, was denkst du über den Launch im Oktober?', 'opinion'],
    ['Verity, wie findest du den Vorschlag von Anna?', 'opinion'],
    ['Verity, sag mal, was hältst du von dem Angebot?', 'opinion'],
    ['Verity, gib mir deine Einschätzung zum Zeitplan.', 'opinion'],
    ['Verity, bewerte bitte das Angebot der Agentur.', 'opinion'],
    ['Verity, fass mal kurz zusammen, was wir beschlossen haben.', 'opinion'],
    ['Verity, erklär mal, was ein CDN ist.', 'opinion'],
    ['Verity, stimmt das mit dem Budget von 20.000 Euro?', 'opinion'],
    ['Verity, finde mal raus, wer das Hosting macht.', 'research'],
    ['Verity, kannst du rausfinden, wer das Hosting macht?', 'research'],
    ['Verity, schlag mal nach, was im Vertrag steht.', 'research'],
    ['Verity, such bitte nach guten Webdesignern.', 'research'],
    ['Verity, checke mal die Hosting-Kosten.', 'research'],
  ] as const)
    expect(latestVoiceMeetingCommand(spoken)?.kind).toBe(kind);
  // Idioms and statements that share the verbs.
  for (const statement of [
    'Verity, mal schauen, ob das bis Oktober klappt.',
    'Verity, mal gucken, was die Agentur sagt.',
    'Verity erklärt uns das nachher.',
    'Verity, bewertet haben wir das schon.',
  ])
    expect(latestVoiceMeetingCommand(statement)).toBeNull();
});

test('keeps a request that mentions the product after its verb', () => {
  // A second wake word that is not a restart must not replace the real request.
  expect(latestVoiceMeetingCommand('Verity, research how Verity check invoices.')).toMatchObject({
    request: 'research how Verity check invoices',
  });
  expect(
    latestVoiceMeetingCommand('Verity, prüfe den Vertrag, Verity recherchiere den Preis.'),
  ).toMatchObject({ request: 'prüfe den Vertrag, Verity recherchiere den Preis' });
});

test('does not send a hesitation while the speaker restarts', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, äh mach mal bitte Research Verity', false);
  jest.advanceTimersByTime(5000);
  expect(dispatch).not.toHaveBeenCalled();
  detector.observe('Verity, äh mach mal bitte Research Verity Research Good Web Designers', false);
  jest.advanceTimersByTime(3000);
  expect(dispatch.mock.calls.map(([command]) => command.request)).toEqual([
    'Research Good Web Designers',
  ]);
  detector.stop();
});

test('does not send an abandoned request when the restart has only reached its verb', () => {
  jest.useFakeTimers();
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, äh mach mal bitte Research Verity Research', false);
  jest.advanceTimersByTime(5000);
  expect(dispatch).not.toHaveBeenCalled();
  detector.stop();
});

test('keeps a later request when an earlier one runs past the length cap', () => {
  // Merging must not drop a valid command just because the combined text is too long.
  const long = `prüfe ${'den sehr langen Vertrag '.repeat(10)}`;
  expect(latestVoiceMeetingCommand(`Verity, ${long}Verity, recherchiere den Preis.`)).toMatchObject(
    {
      request: 'recherchiere den Preis',
    },
  );
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
    expect.objectContaining({ kind: 'research', request: 'recherchiere den Termin im Vertrag' }),
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
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'opinion' }));
  detector.stop();
});

test('dispatches two completed requests from one transcript update in order', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline. Verity, check the budget.', false);
  expect(dispatch.mock.calls.map(([command]) => command.request)).toEqual([
    'research the deadline',
    'check the budget',
  ]);
  detector.stop();
});

test('does not resend a command when earlier wake-word text is revised', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline.', true);
  detector.observe('Verity, can you research the deadline.', true);
  detector.observe('Verity, research the delivery date.', true);
  detector.observe('Someone mentioned Verity earlier. Verity, research the deadline.', true);
  detector.observe('Verity, research the deadline.', true);
  expect(dispatch).toHaveBeenCalledTimes(1);
  detector.observe('Verity, research the deadline. Verity, research the deadline.', true);
  expect(dispatch).toHaveBeenCalledTimes(2);
  detector.stop();
});

test('sends a new request after an earlier recognized request disappears', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the deadline.', true);
  detector.observe('The deadline is settled.', true);
  detector.observe('The deadline is settled. Verity, check the budget.', true);
  expect(dispatch.mock.calls.map(([command]) => command.request)).toEqual([
    'research the deadline',
    'check the budget',
  ]);
});

test('keeps short sentence endings separate in a batched transcript', () => {
  const dispatch = jest.fn();
  const detector = new VoiceMeetingCommandDetector(dispatch);
  detector.observe('Verity, research the UK. Verity, check the budget.', false);
  expect(dispatch.mock.calls.map(([command]) => command.request)).toEqual([
    'research the UK',
    'check the budget',
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
    expect.objectContaining({ request: 'prüfe den neuen Plan' }),
  );
});
