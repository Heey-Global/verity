jest.mock('../../hooks/useAttachmentImageSource', () => ({
  useAttachmentImageSource: () => undefined,
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { MockupReviewScreen } from '@verity/mobile';
import { MockupReviewSheet } from './MockupReview';

const home: MockupReviewScreen = {
  name: 'Home',
  attachment: 'a'.repeat(64),
  mediaType: 'image/png',
  width: 390,
  height: 844,
  verdict: 'open',
};
const props = {
  visible: true,
  screens: [home],
  title: 'Review flow',
  initialScreen: undefined,
  deciding: false,
  error: undefined,
  onDecide: jest.fn(async () => true),
  onSend: jest.fn(async () => true),
  onClose: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it('saves the current screen verdict and trims its comment', async () => {
  render(<MockupReviewSheet {...props} />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
  expect(props.onDecide).toHaveBeenCalledWith('Home', { verdict: 'approved' });
  fireEvent.press(screen.getByRole('button', { name: 'Comment' }));
  expect(screen.getByRole('button', { name: 'Save comment' })).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('Comment'), '  Enlarge the title  ');
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Save comment' })));
  expect(props.onDecide).toHaveBeenLastCalledWith('Home', {
    verdict: 'comment',
    comment: 'Enlarge the title',
  });
});

it('offers sending only once every screen is decided and keeps failed sends open', async () => {
  props.onSend.mockResolvedValueOnce(false);
  const view = render(<MockupReviewSheet {...props} />);
  expect(screen.queryByRole('button', { name: 'Send comments' })).toBeNull();
  view.rerender(
    <MockupReviewSheet {...props} screens={[{ ...home, verdict: 'comment', comment: 'Larger' }]} />,
  );
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Send comments' })));
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Send comments' })));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it('lets a reviewer replace the final comment with approval', async () => {
  render(
    <MockupReviewSheet {...props} screens={[{ ...home, verdict: 'comment', comment: 'Larger' }]} />,
  );
  expect(screen.getByRole('button', { name: 'Send comments' })).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
  expect(props.onDecide).toHaveBeenCalledWith('Home', { verdict: 'approved' });
});
