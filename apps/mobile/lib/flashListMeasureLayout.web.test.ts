/** @jest-environment jsdom */
import { measureFirstChildLayout } from './flashListMeasureLayout.web';

const originalMatrix = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrixReadOnly');

function setup(inverted: boolean, scrollTop = 0) {
  const parent = document.createElement('div');
  const child = document.createElement('div');
  const scroller = document.createElement('div');
  parent.append(scroller);
  scroller.append(child);
  scroller.scrollTop = scrollTop;
  jest.spyOn(parent, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 600 } as DOMRect);
  const top = inverted ? 600 - 16 + scrollTop : 116 - scrollTop;
  jest.spyOn(child, 'getBoundingClientRect').mockReturnValue({ top, bottom: top } as DOMRect);
  jest.spyOn(window, 'getComputedStyle').mockReturnValue({
    transform: inverted ? 'matrix(1, 0, 0, -1, 0, 0)' : 'none',
  } as CSSStyleDeclaration);
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
    configurable: true,
    value: class {
      m22 = -1;
      m12 = 0;
      m21 = 0;
    },
  });
  return { child, parent };
}
afterEach(() => {
  jest.restoreAllMocks();
  if (originalMatrix) Object.defineProperty(globalThis, 'DOMMatrixReadOnly', originalMatrix);
  else Reflect.deleteProperty(globalThis, 'DOMMatrixReadOnly');
});
it.each([0, 200, 12000])(
  'keeps the inverted layout start stable at scroll offset %i',
  (scrollTop) => {
    const { child, parent } = setup(true, scrollTop);
    expect(measureFirstChildLayout(child, parent).y).toBe(16);
  },
);
it('preserves ordinary web list coordinates', () => {
  const { child, parent } = setup(false, 200);
  expect(measureFirstChildLayout(child, parent).y).toBe(16);
});
