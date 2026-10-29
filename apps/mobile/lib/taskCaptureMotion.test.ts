import { Animated } from 'react-native';
import { taskCaptureGlyphOffset } from './taskCaptureMotion';

it.each([393, 768])(
  'centers the glyph in the visible circle throughout docking on a %spt screen',
  (width) => {
    const diameter = 60;
    const x = new Animated.Value(0);
    const offset = taskCaptureGlyphOffset(x, width, diameter);
    const read = () => (offset as unknown as { __getValue(): number }).__getValue();
    // Walk both directions so a side switch cannot introduce a delayed jump.
    const positions = [-30, -24, -15, -1, 0, 50, width / 2, width - 60, width - 45, width - 30];
    for (const position of [...positions, ...positions.toReversed()]) {
      x.setValue(position);
      const visibleLeft = Math.max(0, position);
      const visibleRight = Math.min(width, position + diameter);
      expect(position + diameter / 2 + read()).toBeCloseTo((visibleLeft + visibleRight) / 2);
    }
  },
);
