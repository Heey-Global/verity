import {
  latestResearchQuestion,
  meetingRequestPrompt,
  researchPrompt,
} from './liveMeetingInsights';

test('offers only a question present in the recent transcript', () => {
  expect(latestResearchQuestion('We should check this. Is the deadline still Friday?')).toBe(
    'Is the deadline still Friday?',
  );
  expect(latestResearchQuestion('The deadline is Friday.')).toBeNull();
});

test('keeps research and direct requests in the same meeting context', () => {
  expect(
    researchPrompt('meeting-1', 'Is the deadline still Friday?', 'The schedule changed.'),
  ).toContain('Research this question raised during live meeting meeting-1');
  expect(
    meetingRequestPrompt('meeting-1', 'What do you think?', 'The schedule changed.'),
  ).toContain('The schedule changed.');
});
