import { meetingRequestFromPrompt } from './liveMeetingAnswers';
import { meetingQuestionKey, meetingRequestPrompt, researchPrompt } from './liveMeetingInsights';

test('uses the same identity for spoken and typed variants of a question', () => {
  expect(meetingQuestionKey('Verity, recherchiere mal, Was kostet das?')).toBe(
    meetingQuestionKey('was kostet das'),
  );
  expect(meetingQuestionKey('Was kostet das?')).not.toBe(
    meetingQuestionKey('Was kostet etwas anderes?'),
  );
});

test('keeps research and direct requests in the same meeting context', () => {
  expect(
    researchPrompt('meeting-1', 'Is the deadline still Friday?', 'The schedule changed.'),
  ).toContain('Research this point raised during live meeting meeting-1');
  expect(
    meetingRequestPrompt('meeting-1', 'What do you think?', 'The schedule changed.'),
  ).toContain('The schedule changed.');
});

// Both entry points must carry the budget: spoken fact checks may be classified
// as direct requests, bypassing a research-only instruction.
test.each([researchPrompt, meetingRequestPrompt])(
  'bounds meeting research without losing answer correlation',
  (buildPrompt) => {
    const prompt = buildPrompt(
      'meeting-1',
      'Is Friday correct?',
      'Friday was mentioned.',
      'request-1',
    );
    expect(prompt).toContain('at most 2 targeted web searches');
    expect(prompt).toContain('at most 3 relevant source pages');
    expect(prompt).toContain('under 120 words');
    expect(prompt).toContain('Markdown bullet points');
    expect(prompt).toContain('Never invent facts or citations');
    expect(prompt).toContain('Do not create a plan, delegate to other agents');
    expect(meetingRequestFromPrompt(prompt, 'meeting-1')).toMatchObject({
      request: 'Is Friday correct?',
      requestId: 'request-1',
    });
  },
);
