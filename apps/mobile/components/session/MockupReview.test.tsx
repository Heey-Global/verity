import { readFileSync } from 'node:fs';
import { join } from 'node:path';
jest.mock('../../hooks/useAttachmentImageSource', () => ({
  useAttachmentImageSource: () => undefined,
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView, View } from 'react-native';
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

const spec: MockupReviewScreen = { ...home, name: 'Spec', attachment: 'b'.repeat(64) };

function setPageWidth() {
  fireEvent(screen.UNSAFE_getByType(ScrollView), 'layout', {
    nativeEvent: { layout: { width: 390, height: 600, x: 0, y: 0 } },
  });
}

function swipeTo(index: number) {
  fireEvent(screen.UNSAFE_getByType(ScrollView), 'momentumScrollEnd', {
    nativeEvent: { contentOffset: { x: index * 390, y: 0 } },
  });
}

it('submits the verdict for the screen reached by paging', async () => {
  render(<MockupReviewSheet {...props} screens={[home, spec]} />);
  setPageWidth();
  swipeTo(1);
  expect(screen.getByText('Review flow · 2 of 2')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
  expect(props.onDecide).toHaveBeenCalledWith('Spec', { verdict: 'approved' });
});

it('aligns the opening image with the screen selected from the gallery', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  try {
    render(<MockupReviewSheet {...props} screens={[home, spec]} initialScreen="Spec" />);
    setPageWidth();
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 390, animated: false });
    expect(screen.getByText('Review flow · 2 of 2')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
    expect(props.onDecide).toHaveBeenCalledWith('Spec', { verdict: 'approved' });
  } finally {
    scrollTo.mockRestore();
  }
});

it('realigns a retained pager with its verdict target after closing and reopening', async () => {
  const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo');
  try {
    const view = render(<MockupReviewSheet {...props} screens={[home, spec]} />);
    setPageWidth();
    swipeTo(1);
    view.rerender(<MockupReviewSheet {...props} screens={[home, spec]} visible={false} />);
    scrollTo.mockClear();
    view.rerender(<MockupReviewSheet {...props} screens={[home, spec]} />);
    expect(screen.getByText('Review flow · 1 of 2')).toBeTruthy();
    expect(scrollTo).toHaveBeenLastCalledWith({ x: 0, animated: false });
    await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
    expect(props.onDecide).toHaveBeenCalledWith('Home', { verdict: 'approved' });
  } finally {
    scrollTo.mockRestore();
  }
});

it('drops the old draft when the host replaces a review by revision key', () => {
  // Rendering a keyed fixture alone stays green if the real host loses its key.
  const host = readFileSync(join(__dirname, '../../app/session/[id].tsx'), 'utf8');
  const keyedByRevision = /<MockupReviewSheet\s+key=\{mockupReview\?\.revision\}/.test(host);
  const view = render(
    <View>
      <MockupReviewSheet key={keyedByRevision ? 1 : undefined} {...props} screens={[home, spec]} />
    </View>,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Comment' }));
  fireEvent.changeText(screen.getByLabelText('Comment'), 'Feedback on the previous image');
  view.rerender(
    <View>
      <MockupReviewSheet key={keyedByRevision ? 2 : undefined} {...props} screens={[spec]} />
    </View>,
  );
  expect(screen.queryByDisplayValue('Feedback on the previous image')).toBeNull();
  expect(screen.getByText('Review flow · 1 of 1')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Comment' }));
  expect(screen.getByDisplayValue('')).toBeTruthy();
});
