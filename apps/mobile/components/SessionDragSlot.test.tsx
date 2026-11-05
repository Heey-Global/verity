import React from 'react';
import { Dimensions, Text, useWindowDimensions } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { SessionDragSlot } from './SessionDragSlot';
import { useProjectRowDrag, type ProjectReorderController } from './useProjectReorder';

jest.mock('./useProjectReorder', () => ({
  useProjectRowDrag: jest.fn(() => ({})),
}));
const drag = jest.mocked(useProjectRowDrag);
const Context = React.createContext('initial');
function Content() {
  const { width } = useWindowDimensions();
  return <Text>{`${React.useContext(Context)}:${width}`}</Text>;
}
const children = jest.fn(() => <Content />);
const props = {
  id: 'session:a',
  scope: 'g',
  order: ['session:a'],
  reorder: { reportCompactHeight: jest.fn() } as unknown as ProjectReorderController,
  enabled: true,
  children,
};
beforeEach(() => jest.clearAllMocks());

it('skips equal inputs while allowing descendant context updates', () => {
  const view = render(
    <Context.Provider value="initial">
      <SessionDragSlot {...props} />
    </Context.Provider>,
  );
  view.rerender(
    <Context.Provider value="updated">
      <SessionDragSlot {...props} />
    </Context.Provider>,
  );
  expect(children).toHaveBeenCalledTimes(1);
  expect(drag).toHaveBeenCalledTimes(1);
  expect(view.getByText(`updated:${Dimensions.get('window').width}`)).toBeTruthy();
});

it('forwards changed children, eligibility, order and overlay controller', () => {
  const view = render(<SessionDragSlot {...props} />);
  const nextChildren = jest.fn(() => <Text>Replacement</Text>);
  view.rerender(<SessionDragSlot {...props} children={nextChildren} />);
  expect(view.getByText('Replacement')).toBeTruthy();
  const order = ['session:b', 'session:a'];
  const reorder = { ...props.reorder, draggingSessionId: 'session:a' };
  view.rerender(<SessionDragSlot {...props} enabled={false} order={order} reorder={reorder} />);
  expect(drag).toHaveBeenLastCalledWith(
    expect.objectContaining({ enabled: false, renderedOrder: order, reorder }),
  );
  view.unmount();
});

it('allows window size subscriptions to update descendants through the memo boundary', () => {
  const original = { window: Dimensions.get('window'), screen: Dimensions.get('screen') };
  const view = render(<SessionDragSlot {...props} />);
  try {
    act(() => Dimensions.set({ ...original, window: { ...original.window, width: 1024 } }));
    expect(view.getByText('initial:1024')).toBeTruthy();
    expect(children).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    act(() => Dimensions.set(original));
  }
});
