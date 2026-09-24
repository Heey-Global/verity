import { renderHook } from '@testing-library/react-native';
import type { ForwardedRef } from 'react';
import type { View } from 'react-native';
import type { useAnimatedRef as animatedRefHook } from 'react-native-reanimated';

import { projectHandleRef } from '../lib/projectHandleRef';

// Exercise the installed native ref and Unistyles cleanup implementations;
// Reanimated's normal Jest mock returns a plain object and hides this contract.
const { useAnimatedRef } = jest.requireActual<{ useAnimatedRef: typeof animatedRefHook }>(
  '../../../node_modules/react-native-reanimated/src/hook/useAnimatedRef',
);
const { passForwardedRef } = jest.requireActual<{
  passForwardedRef: <T>(
    node: T,
    ref: ForwardedRef<T>,
    onMount?: () => void,
    onUnmount?: () => void,
  ) => () => void;
}>('../../../node_modules/react-native-unistyles/src/core/passForwardRef');

jest.mock('../../../node_modules/react-native-reanimated/src/common/constants', () => ({
  SHOULD_BE_USE_WEB: false,
}));
jest.mock('../../../node_modules/react-native-reanimated/src/mutables', () => ({
  makeMutable: (value: unknown) => ({ value }),
}));
jest.mock('../../../node_modules/react-native-reanimated/src/fabricUtils', () => ({
  getShadowNodeWrapperFromRef: () => ({ nativeShadowNode: true }),
}));
jest.mock(
  '../../../node_modules/react-native-reanimated/src/platformFunctions/findNodeHandle',
  () => ({
    findNodeHandle: () => 1,
  }),
);
jest.mock('react-native-worklets', () => ({
  createSerializable: (value: unknown) => value,
  serializableMappingCache: new WeakMap(),
}));

it('reproduces the native animated ref being invoked as a cleanup function', () => {
  const { result } = renderHook(() => useAnimatedRef<View>());
  const detach = passForwardedRef({} as View, result.current);
  expect(() => detach()).toThrow(TypeError);
});

it('can detach and reattach the project handle without calling a shadow node', () => {
  const { result } = renderHook(() => useAnimatedRef<View>());
  const callback = projectHandleRef(result.current);
  const onUnmount = jest.fn();
  const first = {} as View;
  const detach = passForwardedRef(first, callback, undefined, onUnmount);
  expect(result.current.current).toBe(first);
  expect(() => detach()).not.toThrow();
  expect(onUnmount).toHaveBeenCalledTimes(1);
  const next = {} as View;
  const detachNext = passForwardedRef(next, callback);
  expect(result.current.current).toBe(next);
  expect(() => detachNext()).not.toThrow();
});
