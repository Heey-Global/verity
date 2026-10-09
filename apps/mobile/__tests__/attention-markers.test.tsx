import { render, screen } from '@testing-library/react-native';
import type { AttentionFlag } from '@verity/mobile';

import { AttentionMarkers, drawsAttentionMarker } from '../components/AttentionMarkers';

const ready: AttentionFlag = {
  kind: 'merge_ready',
  tone: 'done',
  label: 'Ready to merge',
  blocking: false,
};

describe('AttentionMarkers', () => {
  it('keeps the fixed 34px column slot by default', () => {
    render(<AttentionMarkers flags={[ready]} />);
    expect(screen.getByLabelText('Ready to merge')).toHaveStyle({ width: 34 });
  });

  it('drops the column slot inline, so the PR status hugs the issue on line 2', () => {
    render(<AttentionMarkers flags={[ready]} size={13} inline />);
    const marker = screen.getByLabelText('Ready to merge');
    expect(marker).not.toHaveStyle({ width: 34 });
    expect(marker).toHaveStyle({ paddingRight: 5 });
  });
});

describe('drawsAttentionMarker', () => {
  it('is false for a flag the marker does not draw, so the row adds no lone separator', () => {
    expect(drawsAttentionMarker([ready])).toBe(true);
    expect(drawsAttentionMarker([])).toBe(false);
    expect(
      drawsAttentionMarker([{ kind: 'unread', tone: 'active', label: 'Unread', blocking: false }]),
    ).toBe(false);
  });
});
