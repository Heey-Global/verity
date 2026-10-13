import { mobileRuntimeSnapshot } from '@verity/mobile';
import { AppState } from 'react-native';
import { gestureDiagnosticsEnabled, subscribeGestureDiagnostics } from './gestureDiagnostics';

const INTERVAL_MS = 5_000;
const MAX_SAMPLES = 120;
const now = () => performance.now();
const initializedAt = now();
type Screen = 'overview' | 'session' | 'settings' | 'other';
type Sample = ReturnType<typeof mobileRuntimeSnapshot> & {
  at: string;
  runtimeAgeMs: number;
  recordingAgeMs: number;
  screen: Screen;
  timerLagMs: number;
};
let screen: Screen = 'other';
let baseline: Sample | null = null;
let samples: Sample[] = [];
let dropped = 0;
let recordingStartedAt = 0;

/** Classify locally; never retain route parameters, session IDs or settings paths. */
export function setRuntimeDiagnosticsScreen(path: string): void {
  screen =
    path === '/'
      ? 'overview'
      : /^\/session(?:\/|$)/.test(path)
        ? 'session'
        : /^\/settings(?:\/|$)/.test(path)
          ? 'settings'
          : 'other';
}

/** One root-owned sampler. Background suspension must not look like JS congestion. */
export function startRuntimeDiagnostics(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = AppState.currentState === 'active';
  let recording = false;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const capture = (lag: number) => {
    const time = now();
    const sample: Sample = {
      ...mobileRuntimeSnapshot(true),
      at: new Date().toISOString(),
      runtimeAgeMs: Math.round(time - initializedAt),
      recordingAgeMs: Math.round(time - recordingStartedAt),
      screen,
      timerLagMs: Math.round(Math.max(0, lag)),
    };
    baseline ??= sample;
    if (samples.length === MAX_SAMPLES) {
      samples.shift();
      dropped++;
    }
    samples.push(sample);
  };
  const schedule = () => {
    const due = now() + INTERVAL_MS;
    timer = setTimeout(() => {
      timer = undefined;
      if (!recording || !active) return;
      capture(now() - due);
      schedule();
    }, INTERVAL_MS);
  };
  const sync = () => {
    cancel();
    const enabled = gestureDiagnosticsEnabled();
    if (enabled !== recording) {
      baseline = null;
      samples = [];
      dropped = 0;
      mobileRuntimeSnapshot(true);
      recordingStartedAt = now();
    }
    recording = enabled;
    if (recording && active) {
      capture(0);
      schedule();
    }
  };
  const detach = subscribeGestureDiagnostics(sync);
  const subscription = AppState.addEventListener('change', (state) => {
    const next = state === 'active';
    if (next === active) return;
    active = next;
    if (active) mobileRuntimeSnapshot(true);
    sync();
  });
  sync();
  return () => {
    cancel();
    detach();
    subscription.remove();
  };
}

function cloneSample(sample: Sample): Sample {
  return {
    ...sample,
    apiRequestGroups: sample.apiRequestGroups && {
      overview: { ...sample.apiRequestGroups.overview },
      preview: { ...sample.apiRequestGroups.preview },
      session: { ...sample.apiRequestGroups.session },
      other: { ...sample.apiRequestGroups.other },
    },
  };
}

export function exportRuntimeDiagnostics() {
  return {
    enabled: gestureDiagnosticsEnabled(),
    intervalMs: INTERVAL_MS,
    maxSamples: MAX_SAMPLES,
    dropped,
    // Runtime age begins at module initialization, not native process launch.
    // Lag is timer delivery delay, not touch-to-paint or CPU utilization.
    baseline: baseline === null ? null : cloneSample(baseline),
    samples: samples.map(cloneSample),
  };
}
