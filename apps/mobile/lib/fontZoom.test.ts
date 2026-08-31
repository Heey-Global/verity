// Unistyles + AsyncStorage are already mocked globally in jest.setup.ts (the
// official `react-native-unistyles/mocks` and async-storage jest mock). We spy on
// the mocked UnistylesRuntime.updateTheme and use the in-memory AsyncStorage.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UnistylesRuntime } from 'react-native-unistyles';

import {
  DEFAULT_FONT_SCALE,
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  adjustFontScale,
  clampFontScale,
  getFontScale,
  hydrateFontScale,
  scaledTypeRamp,
  setFontScale,
  stepFontScale,
} from './fontZoom';

let updateThemeSpy: jest.SpyInstance;

describe('font zoom', () => {
  beforeEach(async () => {
    updateThemeSpy = jest.spyOn(UnistylesRuntime, 'updateTheme');
    // Reset module state to the default, flush its async persist, then clear
    // storage + spy so each test starts clean.
    setFontScale(DEFAULT_FONT_SCALE);
    await Promise.resolve();
    await AsyncStorage.clear();
    updateThemeSpy.mockClear();
  });

  afterEach(() => {
    updateThemeSpy.mockRestore();
  });

  describe('clampFontScale', () => {
    it('keeps in-range values and rounds to 2 decimals', () => {
      expect(clampFontScale(1.2)).toBe(1.2);
      expect(clampFontScale(1.234)).toBe(1.23);
    });
    it('clamps to the supported range', () => {
      expect(clampFontScale(5)).toBe(MAX_FONT_SCALE);
      expect(clampFontScale(0.1)).toBe(MIN_FONT_SCALE);
    });
    it('falls back to the default for non-finite input', () => {
      expect(clampFontScale(Number.NaN)).toBe(DEFAULT_FONT_SCALE);
      expect(clampFontScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SCALE);
    });
  });

  describe('stepFontScale', () => {
    it('steps up and down by one increment', () => {
      expect(stepFontScale(1, 'in')).toBe(1.1);
      expect(stepFontScale(1, 'out')).toBe(0.9);
    });
    it('resets to the default', () => {
      expect(stepFontScale(1.4, 'reset')).toBe(DEFAULT_FONT_SCALE);
    });
    it('never steps past the bounds', () => {
      expect(stepFontScale(MAX_FONT_SCALE, 'in')).toBe(MAX_FONT_SCALE);
      expect(stepFontScale(MIN_FONT_SCALE, 'out')).toBe(MIN_FONT_SCALE);
    });
  });

  describe('scaledTypeRamp', () => {
    it('multiplies the base ramp and rounds to whole pixels', () => {
      expect(scaledTypeRamp(1)).toEqual({ micro: 10, xs: 12, sm: 14, md: 16, lg: 20, xl: 28 });
      expect(scaledTypeRamp(1.5)).toEqual({ micro: 15, xs: 18, sm: 21, md: 24, lg: 30, xl: 42 });
    });
  });

  describe('setFontScale', () => {
    it('updates every registered theme with the scaled ramp and factor, and persists', async () => {
      setFontScale(1.2);
      expect(getFontScale()).toBe(1.2);
      const themes = updateThemeSpy.mock.calls.map(([name]) => name);
      expect(themes).toEqual(['dark', 'light']);
      const next = updateThemeSpy.mock.calls[0][1]({ fontScale: 1, text: {}, colors: {} });
      expect(next).toMatchObject({ fontScale: 1.2, text: scaledTypeRamp(1.2) });
      // Other theme fields (colors, …) are preserved.
      expect(next).toHaveProperty('colors');
      await Promise.resolve();
      expect(await AsyncStorage.getItem('verity.fontScale')).toBe('1.2');
    });
    it('clamps out-of-range requests before applying', () => {
      setFontScale(9);
      expect(getFontScale()).toBe(MAX_FONT_SCALE);
    });
  });

  describe('adjustFontScale', () => {
    it('applies a relative ⌘+/⌘−/⌘0 step from the current scale', () => {
      setFontScale(1);
      adjustFontScale('in');
      expect(getFontScale()).toBe(1.1);
      adjustFontScale('out');
      adjustFontScale('out');
      expect(getFontScale()).toBe(0.9);
      adjustFontScale('reset');
      expect(getFontScale()).toBe(DEFAULT_FONT_SCALE);
    });
  });

  describe('hydrateFontScale', () => {
    it('restores and applies a persisted scale', async () => {
      await AsyncStorage.setItem('verity.fontScale', '1.3');
      await hydrateFontScale();
      expect(getFontScale()).toBe(1.3);
      expect(updateThemeSpy).toHaveBeenCalled();
    });
    it('keeps the default when nothing is stored', async () => {
      await hydrateFontScale();
      expect(getFontScale()).toBe(DEFAULT_FONT_SCALE);
      expect(updateThemeSpy).not.toHaveBeenCalled();
    });
    it('ignores a malformed stored value', async () => {
      await AsyncStorage.setItem('verity.fontScale', 'not-a-number');
      await hydrateFontScale();
      expect(getFontScale()).toBe(DEFAULT_FONT_SCALE);
    });
  });
});
