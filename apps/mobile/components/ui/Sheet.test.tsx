import { fireEvent, render } from '@testing-library/react-native';
import { ScrollView, Text } from 'react-native';

import { Sheet } from './Sheet';

function scrollEvent(offset: number) {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 390, height: 2000 },
      layoutMeasurement: { width: 390, height: 600 },
    },
  };
}

describe('Sheet anchored at its end', () => {
  afterEach(() => jest.restoreAllMocks());

  function renderSheet(anchorEnd: boolean) {
    const toEnd = jest.spyOn(ScrollView.prototype, 'scrollToEnd').mockImplementation(() => {});
    toEnd.mockClear();
    const screen = render(
      <Sheet visible title="Verity" onClose={jest.fn()} anchorEnd={anchorEnd}>
        <Text>Oldest</Text>
        <Text>Newest</Text>
      </Sheet>,
    );
    const scroll = screen.UNSAFE_getByType(ScrollView);
    return { toEnd, scroll };
  }

  it('opens at the newest entry and follows new ones while the reader is there', () => {
    const { toEnd, scroll } = renderSheet(true);
    // A conversation that opened at its top showed old entries instead of the last answer.
    fireEvent(scroll, 'contentSizeChange', 390, 2000);
    expect(toEnd).toHaveBeenLastCalledWith({ animated: false });
    fireEvent(scroll, 'scrollEndDrag', scrollEvent(1400 - 10));
    fireEvent(scroll, 'contentSizeChange', 390, 2200);
    expect(toEnd).toHaveBeenLastCalledWith({ animated: true });
    expect(toEnd).toHaveBeenCalledTimes(2);
  });

  it('leaves a reader who scrolled up where they are', () => {
    const { toEnd, scroll } = renderSheet(true);
    fireEvent(scroll, 'contentSizeChange', 390, 2000);
    fireEvent(scroll, 'momentumScrollEnd', scrollEvent(200));
    fireEvent(scroll, 'contentSizeChange', 390, 2200);
    expect(toEnd).toHaveBeenCalledTimes(1);
  });

  it('keeps other sheets at their top', () => {
    const { toEnd, scroll } = renderSheet(false);
    fireEvent(scroll, 'contentSizeChange', 390, 2000);
    expect(toEnd).not.toHaveBeenCalled();
  });

  it('keeps following while its own scroll to the end is still under way', () => {
    const { toEnd, scroll } = renderSheet(true);
    fireEvent(scroll, 'contentSizeChange', 390, 2000);
    fireEvent(scroll, 'contentSizeChange', 390, 2200);
    // Mid-animation the offset is far from the end; that is not the reader leaving.
    fireEvent.scroll(scroll, scrollEvent(200));
    fireEvent(scroll, 'contentSizeChange', 390, 2400);
    expect(toEnd).toHaveBeenCalledTimes(3);
  });
});
