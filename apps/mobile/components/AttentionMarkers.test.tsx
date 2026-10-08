import { markerAttention } from '@verity/mobile';
import { render } from '@testing-library/react-native';
import { AttentionMarkers, drawsAttentionMarker } from './AttentionMarkers';

it('keeps an open PR visible when its check status is unavailable', () => {
  const flags = markerAttention({
    status: 'idle',
    pr: { phase: 'open', pipeline: 'unknown', mergeable: null },
  });
  expect(drawsAttentionMarker(flags)).toBe(true);
  const view = render(<AttentionMarkers flags={flags} />);
  expect(view.getByLabelText('PR status unavailable')).toBeTruthy();
});

it('draws a still-settling PR in a different color than a mergeable one', () => {
  // The regression: GitHub's `mergeable: null` window drew the same green ✓ as a
  // merge-ready PR, so the list promised a merge the PR bar's disabled button refused.
  const glyphColor = (mergeable: boolean | null): unknown => {
    const flags = markerAttention({
      status: 'idle',
      pr: { phase: 'open', pipeline: 'success', mergeable },
    });
    const view = render(<AttentionMarkers flags={flags} />);
    const glyph = view.UNSAFE_root.findAll(
      (node) => typeof node.type !== 'string' && node.props.name === 'git-merge',
    )[0];
    return glyph?.props.color;
  };
  const ready = glyphColor(true);
  expect(ready).toBeDefined();
  expect(glyphColor(null)).not.toBe(ready);
});
