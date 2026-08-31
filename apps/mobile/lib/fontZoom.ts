// App-wide font zoom driven by ⌘+ / ⌘− / ⌘0 (see native/VerityKeyCommands.swift
// and components/KeyCommands.tsx). A single scale factor multiplies the theme's
// type ramp AND every explicit `lineHeight` / literal `fontSize` (which read
// `theme.fontScale`) so text and its leading grow together. The factor persists
// across launches.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UnistylesRuntime } from 'react-native-unistyles';

import { baseText, type TypeRamp } from '../theme/tokens';

export const MIN_FONT_SCALE = 0.8;
export const MAX_FONT_SCALE = 1.5;
export const FONT_SCALE_STEP = 0.1;
export const DEFAULT_FONT_SCALE = 1;

const PERSIST_KEY = 'verity.fontScale';

/** Round to 2 decimals so repeated ±0.1 steps don't drift into fp noise. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Clamp an arbitrary scale into the supported range (default on non-finite). */
export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_FONT_SCALE;
  return round2(Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, scale)));
}

export type FontZoomDirection = 'in' | 'out' | 'reset';

/** The next scale for a ⌘+ / ⌘− / ⌘0 command, clamped to range. */
export function stepFontScale(current: number, direction: FontZoomDirection): number {
  if (direction === 'reset') return DEFAULT_FONT_SCALE;
  const delta = direction === 'in' ? FONT_SCALE_STEP : -FONT_SCALE_STEP;
  return clampFontScale(current + delta);
}

/** The type ramp scaled to a factor (rounded to whole pixels). */
export function scaledTypeRamp(scale: number): TypeRamp {
  return {
    micro: Math.round(baseText.micro * scale),
    xs: Math.round(baseText.xs * scale),
    sm: Math.round(baseText.sm * scale),
    md: Math.round(baseText.md * scale),
    lg: Math.round(baseText.lg * scale),
    xl: Math.round(baseText.xl * scale),
  };
}

let currentScale = DEFAULT_FONT_SCALE;

/** Push a scale into every registered theme so all styled components recompute. */
function applyFontScale(scale: number): void {
  const text = scaledTypeRamp(scale);
  for (const name of ['dark', 'light'] as const) {
    UnistylesRuntime.updateTheme(name, (theme) => ({ ...theme, fontScale: scale, text }));
  }
}

export function getFontScale(): number {
  return currentScale;
}

/** Apply + persist a scale (clamped). Persist failures are non-fatal. */
export function setFontScale(scale: number): void {
  currentScale = clampFontScale(scale);
  applyFontScale(currentScale);
  void AsyncStorage.setItem(PERSIST_KEY, String(currentScale)).catch(() => {});
}

/** Handle a ⌘+ / ⌘− / ⌘0 command from the native key-command view. */
export function adjustFontScale(direction: FontZoomDirection): void {
  setFontScale(stepFontScale(currentScale, direction));
}

/** Load the persisted scale at startup and apply it. Never throws. */
export async function hydrateFontScale(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PERSIST_KEY);
    if (raw == null) return;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    currentScale = clampFontScale(parsed);
    if (currentScale !== DEFAULT_FONT_SCALE) applyFontScale(currentScale);
  } catch {
    // Storage hiccup — keep the default scale.
  }
}
