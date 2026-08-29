// The gestures themselves are driven by native recognizers on the UI thread and
// can't be exercised in jest, so this covers the two things that CAN be: the render
// contract every call site relies on (image + caption + × closes), and the pan-bound
// math the gesture handlers delegate to.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { clampOffset, containedSize, ImageLightbox } from './ImageLightbox';

const source = { uri: 'https://verity.test/attachments/abc' };

describe('ImageLightbox', () => {
  it('shows the image and its caption, and closes via the × badge', () => {
    const onClose = jest.fn();
    render(<ImageLightbox source={source} label="EG.png" onClose={onClose} />);

    expect(screen.getByLabelText('EG.png')).toBeTruthy();
    expect(screen.getByText('EG.png')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Close image'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic image label and renders no caption when unlabelled', () => {
    render(<ImageLightbox source={source} onClose={jest.fn()} />);

    expect(screen.getByLabelText('Image')).toBeTruthy();
    expect(screen.queryByText('Image')).toBeNull();
  });
});

describe('containedSize', () => {
  it('fits the image inside the viewport, keeping its aspect ratio', () => {
    // Wide image in a tall viewport → width-bound, with letterbox margins.
    expect(containedSize(2000, 1000, 400, 800)).toEqual({ width: 400, height: 200 });
    // Tall image in a tall viewport → height-bound, with pillarbox margins.
    expect(containedSize(1000, 2000, 400, 800)).toEqual({ width: 400, height: 800 });
  });

  it('falls back to the viewport before the image has reported its size', () => {
    expect(containedSize(0, 0, 400, 800)).toEqual({ width: 400, height: 800 });
  });
});

describe('clampOffset', () => {
  it('pins the offset to 0 while the scaled image still fits', () => {
    expect(clampOffset(120, 1, 400, 400)).toBe(0);
    // A wide image letterboxed into a tall viewport: 200pt tall content at 2× is
    // still shorter than the 800pt viewport, so vertical panning stays locked —
    // clamping against the VIEWPORT here would have allowed ±200.
    expect(clampOffset(120, 2, 800, 200)).toBe(0);
  });

  it('allows exactly the overflow the scaled image has on each side', () => {
    // 400pt content at 2× = 800pt in a 400pt viewport → 200pt of slack per side.
    expect(clampOffset(500, 2, 400, 400)).toBe(200);
    expect(clampOffset(-500, 2, 400, 400)).toBe(-200);
    expect(clampOffset(80, 2, 400, 400)).toBe(80);
  });
});
