import { Platform } from 'react-native';
import { sessionLayout } from './sessionLayout';

describe('session window layout', () => {
  it.each([390, 507, 767])('keeps a %ipt window single-pane', (width) => {
    expect(sessionLayout(width, true).wide).toBe(false);
  });

  it.each([768, 834, 900, 1024, 1366])(
    'splits a %ipt window and leaves room for the chat',
    (width) => {
      const layout = sessionLayout(width, true);
      expect(layout.wide).toBe(true);
      expect(layout.sidebarWidth).toBeGreaterThanOrEqual(280);
      expect(layout.sidebarWidth).toBeLessThanOrEqual(380);
      expect(width - layout.sidebarWidth).toBeGreaterThanOrEqual(488);
    },
  );

  it('grows the sidebar continuously until its maximum', () => {
    expect(sessionLayout(768, true).sidebarWidth).toBe(280);
    expect(sessionLayout(900, true).sidebarWidth).toBe(324);
    expect(sessionLayout(1366, true).sidebarWidth).toBe(380);
    for (let width = 769; width <= 1366; width++) {
      const step =
        sessionLayout(width, true).sidebarWidth - sessionLayout(width - 1, true).sidebarWidth;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(0.361);
    }
  });
});

it('keeps iPhone portrait and landscape single-pane using the native device identity', () => {
  const os = jest.replaceProperty(Platform, 'OS', 'ios');
  const pad = jest
    .spyOn(Platform as typeof Platform & { isPad: boolean }, 'isPad', 'get')
    .mockReturnValue(false);
  try {
    for (const width of [393, 852, 393, 440, 956, 440]) {
      expect(sessionLayout(width).wide).toBe(false);
    }
    pad.mockReturnValue(true);
    expect(sessionLayout(834).wide).toBe(true);
    os.replaceValue('web');
    pad.mockReturnValue(false);
    expect(sessionLayout(1024).wide).toBe(true);
  } finally {
    pad.mockRestore();
    os.restore();
  }
});
