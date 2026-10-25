/** @jest-environment jsdom */
import { attachInvertedWheel } from './invertedWheel';

function setup() {
  const node = document.createElement('div');
  Object.defineProperty(node, 'clientHeight', { value: 300 });
  node.scrollTop = 500;
  const cleanup = attachInvertedWheel(node);
  const wheel = (deltaY: number, options: WheelEventInit = {}, target = node) => {
    const event = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };
  return { node, cleanup, wheel };
}

it('moves both wheel directions opposite the inverted layout coordinates', () => {
  const { node, wheel, cleanup } = setup();
  expect(wheel(40).defaultPrevented).toBe(true);
  expect(node.scrollTop).toBe(460);
  wheel(-80);
  expect(node.scrollTop).toBe(540);
  cleanup();
  expect(wheel(40).defaultPrevented).toBe(false);
  expect(node.scrollTop).toBe(540);
});

it('normalizes line and page deltas and leaves zoom and horizontal input alone', () => {
  const { node, wheel } = setup();
  wheel(2, { deltaMode: 1 });
  expect(node.scrollTop).toBe(468);
  wheel(1, { deltaMode: 2 });
  expect(node.scrollTop).toBe(168);
  expect(wheel(40, { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(wheel(0, { deltaX: 40 }).defaultPrevented).toBe(false);
  expect(node.scrollTop).toBe(168);
});

it('lets nested panes scroll until their edge, then scrolls the transcript', () => {
  const { node, wheel } = setup();
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  Object.defineProperty(pane, 'clientHeight', { value: 100 });
  Object.defineProperty(pane, 'scrollHeight', { value: 400 });
  pane.scrollTop = 100;
  node.appendChild(pane);
  expect(wheel(40, {}, pane).defaultPrevented).toBe(false);
  expect(wheel(-40, {}, pane).defaultPrevented).toBe(false);
  expect(node.scrollTop).toBe(500);
  pane.scrollTop = 300;
  expect(wheel(40, {}, pane).defaultPrevented).toBe(true);
  expect(node.scrollTop).toBe(460);
});
