import { render, screen } from '@testing-library/react-native';

import { AttentionMarkers } from '../components/AttentionMarkers';

const ready = { kind: 'merge_ready', label: 'Ready to merge' } as const;

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
