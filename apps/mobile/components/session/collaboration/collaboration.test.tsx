import type { CollaborationEntry } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { CollaborationRow } from './CollaborationRow';
import { CollaborationSheet } from './CollaborationSheet';
import { rowText, shortAge } from './model';

// The tiles are decorative and hidden from screen readers; the row speaks for them.
const HIDDEN = { includeHiddenElements: true };
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const entry = (overrides: Partial<CollaborationEntry>): CollaborationEntry => ({
  sessionId: 'server-auth',
  sessionName: 'Auth refactor',
  projectId: 'server',
  projectName: 'Server',
  direction: 'asked',
  state: 'working',
  updatedAt: minutesAgo(4),
  section: 'current',
  ...overrides,
});

const MOBILE = entry({
  sessionId: 'mobile-header',
  sessionName: 'Header rework',
  projectId: 'mobile',
  projectName: 'Mobile',
  direction: 'askedBy',
  state: 'answer',
  updatedAt: minutesAgo(12),
});
const DOCS = entry({
  sessionId: 'docs-adr',
  sessionName: 'ADR 0031',
  projectId: 'docs',
  projectName: 'Docs',
  direction: 'handedOver',
  state: 'done',
  updatedAt: minutesAgo(60),
});

function renderRow(entries: CollaborationEntry[]) {
  const onOpenEntry = jest.fn();
  const onOpenList = jest.fn();
  const view = render(
    <CollaborationRow entries={entries} onOpenEntry={onOpenEntry} onOpenList={onOpenList} />,
  );
  return { ...view, onOpenEntry, onOpenList };
}

describe('CollaborationRow', () => {
  it('is absent while the session works alone or only has earlier collaborations', () => {
    renderRow([]);
    expect(screen.queryByTestId('collaboration-row')).toBeNull();
    renderRow([entry({ state: 'done', section: 'earlier' })]);
    expect(screen.queryByTestId('collaboration-row')).toBeNull();
  });

  it('names a single peer and opens it on tap', () => {
    const { onOpenEntry, onOpenList } = renderRow([entry({})]);
    const row = screen.getByRole('button', {
      name: 'Server · Auth refactor, working on your question',
    });
    fireEvent.press(row);
    expect(onOpenEntry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'server-auth' }));
    expect(onOpenList).not.toHaveBeenCalled();
  });

  it('stacks at most three tiles, counts the rest and opens the list', () => {
    const extra = [1, 2].map((index) =>
      entry({ sessionId: `extra-${String(index)}`, projectName: `Extra ${String(index)}` }),
    );
    const { onOpenEntry, onOpenList } = renderRow([entry({}), MOBILE, DOCS, ...extra]);
    expect(screen.getAllByTestId('collaboration-tile', HIDDEN)).toHaveLength(3);
    expect(screen.getByText('+2')).toBeOnTheScreen();
    // The answer leads: news before motion.
    fireEvent.press(
      screen.getByRole('button', { name: /^Answer from Mobile, 3 working · 1 done$/ }),
    );
    expect(onOpenList).toHaveBeenCalledTimes(1);
    expect(onOpenEntry).not.toHaveBeenCalled();
  });

  it('says a waiting decision first', () => {
    renderRow([
      entry({}),
      entry({ sessionId: 'docs', projectName: 'Docs', state: 'waitingForYou' }),
    ]);
    expect(
      screen.getByRole('button', { name: 'Docs needs your approval, 1 working' }),
    ).toBeOnTheScreen();
  });

  it('shows the asked session who asked it', () => {
    renderRow([entry({ direction: 'askedBy' })]);
    expect(
      screen.getByRole('button', {
        name: 'Asked by Server · Auth refactor, waiting for this answer',
      }),
    ).toBeOnTheScreen();
  });

  // Without the announcement a VoiceOver user never learns the answer arrived;
  // with it on the first render, every reopened session would announce old news.
  it('announces an answer that arrives, not one already there', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const { rerender } = renderRow([MOBILE]);
    expect(announce).not.toHaveBeenCalled();
    act(() => {
      rerender(
        <CollaborationRow
          entries={[MOBILE, entry({ state: 'answer' })]}
          onOpenEntry={jest.fn()}
          onOpenList={jest.fn()}
        />,
      );
    });
    expect(announce).toHaveBeenCalledWith('Answer from Server');
    announce.mockRestore();
  });

  // The screen renders the row before its first read lands; answers that were
  // already there must not be announced as news when that read arrives.
  it('stays quiet when the first read brings answers already there', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const props = { onOpenEntry: jest.fn(), onOpenList: jest.fn() };
    const { rerender } = render(<CollaborationRow entries={[]} loaded={false} {...props} />);
    act(() => {
      rerender(<CollaborationRow entries={[MOBILE]} loaded {...props} />);
    });
    expect(announce).not.toHaveBeenCalled();
    announce.mockRestore();
  });

  it('keeps the working ring still while Reduce Motion is on', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    renderRow([entry({})]);
    await act(async () => undefined);
    expect(screen.queryByTestId('collaboration-ring-moving', HIDDEN)).toBeNull();
    expect(screen.getByTestId('collaboration-ring', HIDDEN)).toBeOnTheScreen();
  });

  it('moves the working ring when motion is allowed', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    renderRow([entry({})]);
    await act(async () => undefined);
    expect(screen.getByTestId('collaboration-ring-moving', HIDDEN)).toBeOnTheScreen();
  });
});

describe('CollaborationSheet', () => {
  it('lists current entries, then finished ones under Earlier, and opens a tapped one', () => {
    const onOpen = jest.fn();
    render(
      <CollaborationSheet
        visible
        now={NOW}
        entries={[entry({}), MOBILE, { ...DOCS, section: 'earlier' }]}
        onOpen={onOpen}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText('Earlier')).toBeOnTheScreen();
    expect(screen.getByText('Mobile · asked us · 12 min')).toBeOnTheScreen();
    expect(screen.getByText('Docs · handed over · 1 h')).toBeOnTheScreen();
    // Every state is a tag; "working" keeps its spoken meaning, not just a grey word.
    expect(screen.getByLabelText('Working, in progress')).toBeOnTheScreen();
    expect(screen.getByLabelText('Answer, waiting for you')).toBeOnTheScreen();
    fireEvent.press(screen.getByText('Header rework'));
    expect(onOpen).toHaveBeenCalledWith(MOBILE);
  });
});

describe('collaboration text', () => {
  it('keeps ages short', () => {
    expect([0, 4, 61, 60 * 49].map((minutes) => shortAge(minutesAgo(minutes), NOW))).toEqual([
      'now',
      '4 min',
      '1 h',
      '2 d',
    ]);
  });

  it('says what a handover waits for', () => {
    expect(rowText([entry({ direction: 'handedOver', state: 'waitingForYou' })])).toEqual({
      summary: 'Handover to Server needs approval',
    });
  });
});
