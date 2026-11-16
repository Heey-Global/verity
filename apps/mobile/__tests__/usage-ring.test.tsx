// The usage ring's geometry: where the used arc starts and ends. Every other
// test only counts marks, so a cap that pokes past 12 o'clock or an arc that
// overshoots its share would leave them green while the ring misreads.
import { render, screen } from '@testing-library/react-native';

import { UsageRing } from '../components/ui';

const hidden = { includeHiddenElements: true } as const;

function arc(percent: number) {
  render(<UsageRing label="5h" percent={percent} pace={50} level="calm" size={34} />);
  const props = screen.getByTestId('usage-ring-arc', hidden).props;
  const [dash] = String(props.strokeDasharray).split(/[ ,]+/).map(Number);
  // The arc starts where its rotation puts it: -90° is 12 o'clock. A dash
  // offset would shift it too, so it is folded in rather than assumed absent.
  // A react-native-svg change in how it serialises transforms must fail here,
  // not turn every position into NaN.
  expect(props.matrix).toHaveLength(6);
  const [a, b] = props.matrix as number[];
  const turn = ((Math.atan2(b!, a!) * 180) / Math.PI + 90 + 360) % 360;
  const offset =
    Number(props.strokeDashoffset ?? 0) -
    ((turn > 180 ? turn - 360 : turn) / 360) * 2 * Math.PI * Number(props.r);
  const width = Number(props.strokeWidth);
  // react-native-svg passes the cap to native code as an enum (1 = round).
  const round = props.strokeLinecap === 1 || props.strokeLinecap === 'round';
  const circumference = 2 * Math.PI * Number(props.r);
  // Where the painted stroke begins and ends along the circle, measured from
  // 12 o'clock, including what a cap adds.
  const cap = round ? width / 2 : 0;
  return { start: -offset - cap, end: -offset + dash! + cap, circumference };
}

describe('UsageRing', () => {
  it('starts the used arc exactly at 12 o’clock and ends it at the used share', () => {
    const { start, end, circumference } = arc(13);
    expect(start).toBeCloseTo(0, 5);
    expect(end).toBeCloseTo((circumference * 13) / 100, 5);
  });

  it('keeps a sliver of use inside its share instead of growing a cap past 12 o’clock', () => {
    const { start, end, circumference } = arc(0.5);
    expect(start).toBeGreaterThanOrEqual(-1e-6);
    expect(end).toBeLessThanOrEqual((circumference * 0.5) / 100 + 0.02);
  });

  it('closes a full ring without caps overlapping at the top', () => {
    const { start, end, circumference } = arc(100);
    expect(start).toBeCloseTo(0, 5);
    expect(end).toBeCloseTo(circumference, 5);
  });
});
