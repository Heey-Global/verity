import { readFileSync } from 'node:fs';
import { join } from 'node:path';
jest.mock('../../hooks/useAttachmentImageSource', () => ({
  // A real source, so the full-size viewer (which needs one) renders too.
  useAttachmentImageSource: () => ({ uri: 'https://verity.test/attachments/a' }),
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
  onComplete: jest.fn(async () => undefined),
  onClose: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

it('marks the current screen and takes the mark back on a second tap', async () => {
  const view = render(<MockupReviewSheet {...props} />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approve' })));
  expect(props.onDecide).toHaveBeenLastCalledWith('Home', { verdict: 'approved' });
  view.rerender(<MockupReviewSheet {...props} screens={[{ ...home, verdict: 'approved' }]} />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Approved' })));
  expect(props.onDecide).toHaveBeenLastCalledWith('Home', { verdict: 'open' });
});

it('switches a screen from approved to discarded in one tap', async () => {
  render(<MockupReviewSheet {...props} screens={[{ ...home, verdict: 'approved' }]} />);
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Discard' })));
  expect(props.onDecide).toHaveBeenLastCalledWith('Home', { verdict: 'discarded' });
});

it('shows the mark on the screen and offers nothing to send', () => {
  render(<MockupReviewSheet {...props} screens={[{ ...home, verdict: 'discarded' }]} />);
  expect(screen.getByRole('button', { name: 'Discarded' })).toBeTruthy();
  expect(screen.getByLabelText('Discarded, needs attention')).toBeTruthy();
  // Comments go into the chat; a field or send action here would split the conversation.
  expect(screen.queryByRole('button', { name: /comment|send/i })).toBeNull();
});

it('locks both marks while one is being saved', () => {
  render(<MockupReviewSheet {...props} deciding />);
  fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
  fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
  fireEvent.press(screen.getByRole('button', { name: 'End review' }));
  expect(props.onDecide).not.toHaveBeenCalled();
  expect(props.onComplete).not.toHaveBeenCalled();
});

it('ends the review separately from marking screens or closing the viewer', async () => {
  render(<MockupReviewSheet {...props} />);
  expect(screen.getByText(/This does not start implementation/)).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'End review' })));
  expect(props.onComplete).toHaveBeenCalledTimes(1);
  expect(props.onDecide).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
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

it('opens a revised round at its first screen when the host keys it by revision', () => {
  // Rendering a keyed fixture alone stays green if the real host loses its key.
  const host = readFileSync(join(__dirname, '../../app/session/[id].tsx'), 'utf8');
  const keyedByRevision = /<MockupReviewSheet\s+key=\{mockupReview\?\.revision\}/.test(host);
  const view = render(
    <View>
      <MockupReviewSheet key={keyedByRevision ? 1 : undefined} {...props} screens={[home, spec]} />
    </View>,
  );
  setPageWidth();
  swipeTo(1);
  expect(screen.getByText('Review flow · 2 of 2')).toBeTruthy();
  view.rerender(
    <View>
      <MockupReviewSheet key={keyedByRevision ? 2 : undefined} {...props} screens={[spec, home]} />
    </View>,
  );
  // A kept position would mark a screen of the new round the user has not seen.
  expect(screen.getByText('Review flow · 1 of 2')).toBeTruthy();
});

it('enlarges the tapped screen in the full-screen viewer and closes it again', () => {
  render(<MockupReviewSheet {...props} />);
  expect(screen.queryByLabelText('Close image')).toBeNull();

  fireEvent.press(screen.getByLabelText('Enlarge Home'));
  expect(screen.getByLabelText('Close image')).toBeTruthy();
  // Enlarging is only for looking: it marks nothing and leaves the review open.
  expect(props.onDecide).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();

  fireEvent.press(screen.getByLabelText('Close image'));
  expect(screen.queryByLabelText('Close image')).toBeNull();
});

it('does not bring back an enlarged screen when the review is reopened', () => {
  const view = render(<MockupReviewSheet {...props} />);
  fireEvent.press(screen.getByLabelText('Enlarge Home'));
  view.rerender(<MockupReviewSheet {...props} visible={false} />);
  view.rerender(<MockupReviewSheet {...props} />);
  expect(screen.queryByLabelText('Close image')).toBeNull();
});
