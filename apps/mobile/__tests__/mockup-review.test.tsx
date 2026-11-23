import { fireEvent, render, screen } from '@testing-library/react-native';
import type { MockupScreenView } from '@verity/mobile';
import { View } from 'react-native';

jest.mock('../hooks/useAttachmentImageSource', () => ({
  useAttachmentImageSource: () => undefined,
}));

jest.mock('../components/session/HtmlMockupPreview', () => ({
  HtmlMockupPreview: ({ attachment }: { attachment: string }) =>
    require('react').createElement(require('react-native').View, { testID: attachment }),
}));

import { MockupPager, MockupReviewSheet } from '../components/session/MockupReview';

const html: MockupScreenView = {
  name: 'Pricing',
  attachment: 'pricing-html',
  mediaType: 'text/html',
  width: 840,
  height: 600,
  verdict: 'open',
};

const image: MockupScreenView = {
  ...html,
  name: 'Screenshot',
  attachment: 'pricing-image',
  mediaType: 'image/png',
};

it('describes an active HTML screen in chat without adding another review entry', () => {
  render(<MockupPager screens={[html]} current onOpen={jest.fn()} />);

  expect(screen.getByText('Interactive mockup')).toBeOnTheScreen();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByTestId(html.attachment)).toBeNull();
});

it('opens the archived HTML attachment without allowing marks', () => {
  render(<MockupPager screens={[html]} current={false} onOpen={jest.fn()} />);

  fireEvent.press(screen.getByRole('button', { name: 'View Pricing mockup' }));

  expect(screen.getByTestId(html.attachment)).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'End review' })).toBeNull();
});

it('switches viewport widths when there is room and marks the selected screen', () => {
  const onDecide = jest.fn().mockResolvedValue(true);
  const sheet = render(
    <MockupReviewSheet
      visible
      screens={[html, image]}
      title="Mockups"
      initialScreen={html.name}
      deciding={false}
      error={undefined}
      onDecide={onDecide}
      onComplete={jest.fn()}
      onClose={jest.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Desktop' })).toBeNull();
  const stage = sheet.UNSAFE_getAllByType(View).find((view) => view.props.onLayout);
  if (stage === undefined) throw new Error('Missing review stage layout handler');
  fireEvent(stage, 'layout', { nativeEvent: { layout: { width: 1024 } } });
  expect(screen.getByRole('button', { name: 'Desktop', selected: true })).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Phone' }));
  expect(screen.getByRole('button', { name: 'Phone', selected: true })).toBeOnTheScreen();
  expect(screen.getByTestId(html.attachment)).toBeOnTheScreen();

  fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
  expect(onDecide).toHaveBeenLastCalledWith(html.name, { verdict: 'approved' });

  fireEvent.press(screen.getByRole('button', { name: 'Next screen' }));
  expect(screen.queryByTestId(html.attachment)).toBeNull();
  expect(screen.getByLabelText('Screenshot mockup')).toBeOnTheScreen();
  fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
  expect(onDecide).toHaveBeenLastCalledWith(image.name, { verdict: 'discarded' });
});
