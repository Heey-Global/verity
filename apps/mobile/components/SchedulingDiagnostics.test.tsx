import { act, render } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SchedulingDiagnostics } from './SchedulingDiagnostics';
import { exportGestureDiagnostics, setGestureDiagnosticsEnabled } from '../lib/gestureDiagnostics';

beforeEach(() => {
  jest.useFakeTimers();
  setGestureDiagnosticsEnabled(false);
});
afterEach(() => {
  setGestureDiagnosticsEnabled(false);
  jest.useRealTimers();
});

it('keeps the child mounted when recording changes and collects nothing while off', async () => {
  const mount = jest.fn();
  function Child() {
    const React = require('react');
    React.useEffect(mount, []);
    return <Text>Chat</Text>;
  }
  const pane = () => (
    <SchedulingDiagnostics stage="session">
      <Child />
    </SchedulingDiagnostics>
  );
  const screen = render(pane());
  expect(exportGestureDiagnostics().events).toEqual([]);
  setGestureDiagnosticsEnabled(true);
  screen.rerender(pane());
  await act(async () => {
    await Promise.resolve();
  });
  act(() => jest.runOnlyPendingTimers());
  expect(mount).toHaveBeenCalledTimes(1);
  const events = exportGestureDiagnostics().events;
  expect(events.map((event) => event.event)).toEqual(
    expect.arrayContaining([
      'session-layout-effect',
      'session-passive-effect',
      'session-microtask',
      'session-timer',
    ]),
  );
  expect(events.find((event) => event.event === 'session-timer')?.detail?.waitMs).toEqual(
    expect.any(Number),
  );
  screen.unmount();
});

it('cancels pending probes when the boundary unmounts', async () => {
  setGestureDiagnosticsEnabled(true);
  const screen = render(
    <SchedulingDiagnostics stage="sidebar">
      <Text>List</Text>
    </SchedulingDiagnostics>,
  );
  screen.unmount();
  await act(async () => {
    await Promise.resolve();
  });
  act(() => jest.runOnlyPendingTimers());
  expect(exportGestureDiagnostics().events.map((event) => event.event)).not.toContain(
    'sidebar-timer',
  );
  expect(exportGestureDiagnostics().events.map((event) => event.event)).not.toContain(
    'sidebar-microtask',
  );
});

it('does not deliver pending probes into a restarted recording', async () => {
  setGestureDiagnosticsEnabled(true);
  const screen = render(
    <SchedulingDiagnostics stage="session">
      <Text>Chat</Text>
    </SchedulingDiagnostics>,
  );
  setGestureDiagnosticsEnabled(false);
  setGestureDiagnosticsEnabled(true);
  await act(async () => {
    await Promise.resolve();
  });
  act(() => jest.runOnlyPendingTimers());
  expect(exportGestureDiagnostics().events).toEqual([]);
  screen.unmount();
});
