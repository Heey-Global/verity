import type { InboxAction } from '@verity/mobile';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Button } from '../ui';
import { AnswerButtons, INLINE_ANSWERS, SHORT_ANSWER } from './AnswerSheet';

const answer = (label: string): InboxAction => ({
  kind: 'answer',
  label,
  answer: label,
  sessionId: 's1',
});

it('shows the maximum short answers as small answer buttons', () => {
  const onAnswer = jest.fn();
  const answers = Array.from({ length: INLINE_ANSWERS }, (_, i) =>
    answer(`${String(i)}${'x'.repeat(SHORT_ANSWER - 1)}`),
  );
  const view = render(
    <AnswerButtons
      answers={answers}
      pending={false}
      disabled={false}
      onAnswer={onAnswer}
      onMore={jest.fn()}
    />,
  );
  expect(view.UNSAFE_getAllByType(Button)).toHaveLength(INLINE_ANSWERS);
  for (const button of view.UNSAFE_getAllByType(Button)) {
    expect(button.props).toMatchObject({ size: 'small', variant: 'answer' });
  }
  fireEvent.press(screen.getByRole('button', { name: answers[0]!.label }));
  expect(onAnswer).toHaveBeenCalledWith(answers[0]);
});

it.each(['long', 'many'])('groups all %s answers into one sheet entry', (kind) => {
  const onAnswer = jest.fn();
  const onMore = jest.fn();
  const answers =
    kind === 'long'
      ? [answer('x'.repeat(SHORT_ANSWER + 1)), answer('Short')]
      : Array.from({ length: INLINE_ANSWERS + 1 }, (_, i) => answer(String(i)));
  render(
    <AnswerButtons
      answers={answers}
      pending={false}
      disabled={false}
      onAnswer={onAnswer}
      onMore={onMore}
    />,
  );
  expect(screen.queryByText(answers[0]!.label)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: `${String(answers.length)} answers` }));
  expect(onMore).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
});

it('locks a pending answer group against reopening', () => {
  const onMore = jest.fn();
  render(
    <AnswerButtons
      answers={[answer('x'.repeat(SHORT_ANSWER + 1))]}
      pending="answer:pending"
      disabled
      onAnswer={jest.fn()}
      onMore={onMore}
    />,
  );
  expect(screen.getByTestId('button-spinner')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: '1 answers' }));
  expect(onMore).not.toHaveBeenCalled();
});
