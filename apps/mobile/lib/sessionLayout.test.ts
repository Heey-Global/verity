import { sessionLayout } from './sessionLayout';

describe('session window layout', () => {
  it.each([390, 507, 767])('keeps a %ipt window single-pane', (width) => {
    expect(sessionLayout(width).wide).toBe(false);
  });

  it.each([768, 834, 900, 1024, 1366])(
    'splits a %ipt window and leaves room for the chat',
    (width) => {
      const layout = sessionLayout(width);
      expect(layout.wide).toBe(true);
      expect(layout.sidebarWidth).toBeGreaterThanOrEqual(280);
      expect(layout.sidebarWidth).toBeLessThanOrEqual(380);
      expect(width - layout.sidebarWidth).toBeGreaterThanOrEqual(488);
    },
  );

  it('grows the sidebar continuously until its maximum', () => {
    expect(sessionLayout(768).sidebarWidth).toBe(280);
    expect(sessionLayout(900).sidebarWidth).toBe(324);
    expect(sessionLayout(1366).sidebarWidth).toBe(380);
    for (let width = 769; width <= 1366; width++) {
      const step = sessionLayout(width).sidebarWidth - sessionLayout(width - 1).sidebarWidth;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(0.361);
    }
  });
});
