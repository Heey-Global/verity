// The overview's usage rings: which windows they show, when a figure appears,
// how a spent window reads, and where the overview places them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ProviderLimitRow, ProviderLimitState } from '@verity/mobile';
import ts from 'typescript';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (href: unknown) => mockPush(href) } }));

import { ProviderUsageGroup, ProviderUsageStrip } from '../components/ProviderUsage';

const HOUR = 3600;
// The rings are hidden from assistive technology — the group speaks for them —
// so queries for their labels and pace lines must include hidden elements.
const hidden = { includeHiddenElements: true } as const;
// The visible row, without the invisible copy that measures its full width.
const row = () => within(screen.getByTestId('provider-usage'));

function limit(
  window: 'five_hour' | 'weekly',
  usedPercent: number | undefined,
  { status = 'allowed', resetsIn = window === 'five_hour' ? HOUR : 3 * 24 * HOUR } = {},
): ProviderLimitState {
  return {
    status,
    window,
    resetsAt: Math.floor(Date.now() / 1000) + resetsIn,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
  };
}

const claude = (fiveHour: ProviderLimitState | null): ProviderLimitRow => ({
  providerLabel: 'Claude',
  fiveHour,
  weekly: limit('weekly', 54),
});
// Codex currently reports no five-hour window.
const codex: ProviderLimitRow = {
  providerLabel: 'Codex',
  fiveHour: null,
  weekly: limit('weekly', 20),
};

beforeEach(() => mockPush.mockReset());

describe('ProviderUsageGroup', () => {
  it('leaves out a window without data, for every provider', () => {
    // An empty ring would read as "nothing used" for a window that is not
    // measured at all — for Codex today, and for Claude between windows.
    render(
      <ProviderUsageGroup rows={[claude(limit('five_hour', 72)), codex]} presentation="popover" />,
    );
    expect(row().getAllByText('5h', hidden)).toHaveLength(1);
    expect(row().getAllByText('W', hidden)).toHaveLength(2);

    screen.rerender(<ProviderUsageGroup rows={[claude(null), codex]} presentation="popover" />);
    expect(row().queryByText('5h', hidden)).toBeNull();
    expect(row().getAllByText('W', hidden)).toHaveLength(2);
  });

  it('leaves out a provider with no window at all, and renders nothing without any', () => {
    const empty: ProviderLimitRow = { providerLabel: 'Codex', fiveHour: null, weekly: null };
    render(<ProviderUsageGroup rows={[empty]} presentation="popover" />);
    expect(screen.queryByTestId('provider-usage')).toBeNull();

    screen.unmount();
    render(<ProviderUsageStrip rows={[]} />);
    expect(screen.queryByTestId('provider-usage-strip')).toBeNull();
  });

  it('shows a figure only from the meter threshold on', () => {
    render(<ProviderUsageGroup rows={[claude(limit('five_hour', 72))]} presentation="popover" />);
    expect(screen.queryByText('72%')).toBeNull();

    screen.rerender(
      <ProviderUsageGroup rows={[claude(limit('five_hour', 93))]} presentation="popover" />,
    );
    expect(screen.getByText('93%')).toBeOnTheScreen();
  });

  it('marks a spent window as "Limit" and draws no pace line on it', () => {
    render(
      <ProviderUsageGroup
        rows={[claude(limit('five_hour', 100, { status: 'rejected' }))]}
        presentation="popover"
      />,
    );
    expect(screen.getByText('Limit')).toBeOnTheScreen();
    // Only the weekly ring, which still has a pace to keep, carries a pace line.
    expect(row().getAllByTestId('usage-ring-pace', hidden)).toHaveLength(1);
  });

  it('says a spent window has reached its limit, even short of 100 %', () => {
    // The visible "Limit" sits inside the button whose label replaces it, so
    // the label alone has to carry the exhaustion.
    render(
      <ProviderUsageGroup
        rows={[claude(limit('five_hour', 80, { status: 'rejected' }))]}
        presentation="popover"
      />,
    );
    const label = screen.getByTestId('provider-usage').props.accessibilityLabel as string;
    expect(label).toMatch(/5-hour window, 80 percent used, Limit reached, resets /);
  });

  it('draws a pace line on every window that has one', () => {
    render(
      <ProviderUsageGroup rows={[claude(limit('five_hour', 72)), codex]} presentation="popover" />,
    );
    expect(row().getAllByTestId('usage-ring-pace', hidden)).toHaveLength(3);
  });

  it('moves the pace line with the clock while the data stays the same', () => {
    // The header only re-renders when the rows change; an idle window must
    // still advance its even-pace position, or the line freezes until a poll
    // brings different numbers.
    jest.useFakeTimers();
    try {
      render(<ProviderUsageGroup rows={[codex]} presentation="popover" />);
      const position = () => {
        const props = row().getByTestId('usage-ring-pace', hidden).props;
        return `${props.x1},${props.y1}`;
      };
      const before = position();
      act(() => {
        jest.advanceTimersByTime(30 * 60_000);
      });
      expect(position()).not.toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });

  it('speaks every window with its figure and reset', () => {
    render(
      <ProviderUsageGroup rows={[claude(limit('five_hour', 72)), codex]} presentation="popover" />,
    );
    const label = screen.getByTestId('provider-usage').props.accessibilityLabel as string;
    // One hour of five left: an even pace would be at 80 %.
    expect(label).toMatch(
      /Claude: 5-hour window, 72 percent used, 8% of room to even pace, resets /,
    );
    expect(label).toMatch(/This week, 54 percent used/);
    expect(label).toMatch(/Codex: This week, 20 percent used/);
    expect(label).not.toMatch(/Codex: 5-hour/);
  });

  it('drops the reset times, not the rings, when the slot is too narrow', () => {
    render(<ProviderUsageGroup rows={[codex]} presentation="popover" />);
    const reset = /^\w{3} \d/;
    expect(screen.getByText(reset)).toBeOnTheScreen();
    fireEvent(screen.getByTestId('provider-usage-measure', hidden), 'layout', {
      nativeEvent: { layout: { width: 120, height: 44, x: 0, y: 0 } },
    });
    fireEvent(screen.getByTestId('provider-usage-slot'), 'layout', {
      nativeEvent: { layout: { width: 80, height: 44, x: 0, y: 0 } },
    });
    expect(screen.queryByText(reset)).toBeNull();
    expect(row().getByText('W', hidden)).toBeOnTheScreen();
  });

  it('opens the details as a sheet on a phone and links to the provider settings', () => {
    render(<ProviderUsageStrip rows={[claude(limit('five_hour', 72)), codex]} />);
    fireEvent.press(screen.getByTestId('provider-usage'));
    expect(screen.getByText('Agent usage')).toBeOnTheScreen();
    expect(screen.getByText('5-hour window · 72% used')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('link', { name: 'Codex settings' }));
    expect(mockPush).toHaveBeenCalledWith('/settings/services/codex');
  });
});

describe('overview placement', () => {
  // The rings must stay where the overview's design puts them: in the header
  // on a wide screen and in a fixed row above Home and Projects on a phone. A
  // refactor that dropped either call would leave every component test green.
  const file = join(__dirname, '../app/index.tsx');
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const jsxNamed = (root: ts.Node, name: string) => {
    const found: ts.Node[] = [];
    const walk = (node: ts.Node) => {
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        node.tagName.getText() === name
      )
        found.push(node);
      ts.forEachChild(node, walk);
    };
    walk(root);
    return found;
  };

  it('hands the group to the header as headerRight on a wide screen only', () => {
    const setOptions = nodes.find(
      (node) => ts.isCallExpression(node) && node.expression.getText() === 'navigation.setOptions',
    ) as ts.CallExpression | undefined;
    expect(setOptions).toBeDefined();
    const headerRight = (setOptions!.arguments[0] as ts.ObjectLiteralExpression).properties.find(
      (property) => property.name?.getText() === 'headerRight',
    ) as ts.PropertyAssignment | undefined;
    expect(headerRight).toBeDefined();
    const condition = headerRight!.initializer;
    expect(ts.isConditionalExpression(condition)).toBe(true);
    expect((condition as ts.ConditionalExpression).condition.getText()).toMatch(/^wide &&/);
    expect(
      jsxNamed((condition as ts.ConditionalExpression).whenTrue, 'ProviderUsageGroup'),
    ).toHaveLength(1);
  });

  it('puts the fixed row above both phone tabs, and nowhere else', () => {
    const phoneReturn = nodes.find(
      (node) =>
        ts.isIfStatement(node) &&
        node.expression.getText() === '!wide' &&
        ts.isReturnStatement(node.thenStatement),
    ) as ts.IfStatement | undefined;
    expect(phoneReturn).toBeDefined();
    expect(jsxNamed(phoneReturn!.thenStatement, 'ProviderUsageStrip')).toHaveLength(1);
    // `sidebar` holds Home and Projects; the strip must sit beside it, not in one tab.
    expect(phoneReturn!.thenStatement.getText()).toMatch(
      /<ProviderUsageStrip[^>]*\/>\s*\{sidebar\}/,
    );
    expect(jsxNamed(source, 'ProviderUsageStrip')).toHaveLength(1);
  });
});
