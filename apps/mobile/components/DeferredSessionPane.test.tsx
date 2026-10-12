import { act, render } from '@testing-library/react-native';
import { Text, View } from 'react-native';
import { DeferredSessionPane } from './DeferredSessionPane';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  jest.spyOn(global, 'cancelAnimationFrame').mockImplementation((id) => {
    if (id != null) frames.delete(id);
  });
});
afterEach(() => jest.restoreAllMocks());
function frame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

it('renders selection feedback before invoking the expensive child', () => {
  const mount = jest.fn();
  function Chat() {
    mount();
    return <Text>Chat</Text>;
  }
  const screen = render(
    <DeferredSessionPane fallback={<Text>Loading selected session</Text>}>
      <Chat />
    </DeferredSessionPane>,
  );
  expect(screen.getByText('Loading selected session')).toBeTruthy();
  expect(mount).not.toHaveBeenCalled();
  frame();
  expect(mount).not.toHaveBeenCalled();
  frame();
  expect(screen.getByText('Chat')).toBeTruthy();
});

it('replaces old content and cancels superseded mounts during rapid switches', () => {
  const mount = jest.fn();
  function Chat({ id }: { id: string }) {
    mount(id);
    return <Text>{id}</Text>;
  }
  const pane = (id: string) => (
    <View>
      <DeferredSessionPane key={id} fallback={<Text>Loading {id}</Text>}>
        <Chat id={id} />
      </DeferredSessionPane>
    </View>
  );
  const screen = render(pane('a'));
  frame();
  frame();
  screen.rerender(pane('b'));
  expect(screen.queryByText('a')).toBeNull();
  frame();
  const stale = [...frames.values()];
  screen.rerender(pane('c'));
  act(() => stale.forEach((callback) => callback(0)));
  expect(screen.getByText('Loading c')).toBeTruthy();
  frame();
  frame();
  expect(screen.getByText('c')).toBeTruthy();
  expect(mount).not.toHaveBeenCalledWith('b');
  screen.rerender(pane('d'));
  screen.unmount();
  expect(frames.size).toBe(0);
});
