import { AppState, type AppStateStatus } from 'react-native';
import { beginSessionSwitch } from '@verity/mobile';
import { markInitialListLoad, startStallSampling } from './sessionSwitchTiming';

let clock = 0;
let background: (state: AppStateStatus) => void;
const remove = jest.fn();
beforeEach(() => {
  clock = 0;
  jest.useFakeTimers();
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    background = listener;
    return { remove };
  });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
});
afterEach(() => {
  background('background');
  jest.useRealTimers();
  jest.restoreAllMocks();
});
it('aggregates JS timer lag and stops after initial list completion', () => {
  const trace = beginSessionSwitch('a');
  startStallSampling(trace);
  clock = 850;
  jest.advanceTimersByTime(100);
  expect(trace.phases.find((p) => p.phase === 'js-timer-lag-max-ms')?.value).toBe(750);
  markInitialListLoad(trace);
  clock = 2000;
  jest.advanceTimersByTime(100);
  expect(jest.getTimerCount()).toBe(0);
});
it('stops a superseded trace without assigning lag to the next gesture', () => {
  const old = beginSessionSwitch('a');
  startStallSampling(old);
  beginSessionSwitch('b');
  clock = 900;
  jest.advanceTimersByTime(100);
  expect(old.phases).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
});
it('stops on background and at the bounded sampling deadline', () => {
  const trace = beginSessionSwitch('a');
  startStallSampling(trace);
  background('background');
  expect(jest.getTimerCount()).toBe(0);
  startStallSampling(trace);
  clock = 10001;
  jest.advanceTimersByTime(100);
  expect(jest.getTimerCount()).toBe(0);
});

it('captures overdue timer lag when loading completes before the timer callback', () => {
  const trace = beginSessionSwitch('completion');
  startStallSampling(trace);
  clock = 900;
  markInitialListLoad(trace);
  expect(trace.phases.find((p) => p.phase === 'js-timer-lag-max-ms')?.value).toBe(800);
  expect(jest.getTimerCount()).toBe(0);
});
