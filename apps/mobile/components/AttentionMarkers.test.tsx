import { markerAttention } from '@verity/mobile';
import { render } from '@testing-library/react-native';
import { AttentionMarkers, drawsAttentionMarker } from './AttentionMarkers';

jest.mock('../lib/pulse', () => ({
  useSyncedPulse: () => {
    const { Animated } = require('react-native') as typeof import('react-native');
    return new Animated.Value(1);
  },
}));

it('keeps an open PR visible when its check status is unavailable', () => {
  const flags = markerAttention({
    status: 'idle',
    pr: { phase: 'open', pipeline: 'unknown', mergeable: null },
  });
  expect(drawsAttentionMarker(flags)).toBe(true);
  const view = render(<AttentionMarkers flags={flags} />);
  expect(view.getByLabelText('PR status unavailable')).toBeTruthy();
});
