// The project Wiki as pages (components/knowledge/WikiViews, WikiPageParts).
//
// The failures worth guarding are the quiet ones: a list that falls back to
// file names, a decision shown without the status agents are bound by, a
// superseded decision passing for a current one, a link that opens nothing or
// opens something outside the project's knowledge, and a page section that
// appears empty instead of not at all.
jest.mock('expo-router', () => require('./support/settingsHarness').expoRouterMock());
jest.mock('../lib/client', () => require('./support/settingsHarness').clientMock());

import type { VerityClient, WikiCatalog } from '@verity/mobile';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { KnowledgeScreen } from '../components/knowledge/KnowledgeBrowser';
import { KnowledgeFileView } from '../components/knowledge/KnowledgeFileView';
import { KnowledgePaneContext } from '../components/knowledge/KnowledgePane';
import {
  DECISIONS,
  folderTitle,
  topicFolder,
  WIKI_FILES,
  wikiView,
} from '../components/knowledge/knowledgeScope';
import { invalidateWikiCatalog } from '../components/knowledge/useWikiCatalog';
import { wikiDayInline } from '../components/knowledge/WikiViews';
import { fileMarkdownItems } from '../lib/fileMarkdownPreview';
import { mockCreateVerityClient, mockPush, resetSettingsHarness } from './support/settingsHarness';

const PROJECT = { kind: 'project', projectId: 'p' } as const;
const today = new Date().toISOString();
const DECISION_A = `insights/decisions/${'a'.repeat(32)}.md`;
const DECISION_B = `insights/decisions/${'b'.repeat(32)}.md`;

const catalog: WikiCatalog = {
  pages: [
    {
      path: 'insights/nav.md',
      title: 'Navigation concept',
      summary: 'What the project page shows.',
      modifiedAt: today,
      links: [DECISION_B, 'sources/meetings/2026-11-07-live-meeting.md'],
      linkedFrom: ['insights/roles.md'],
    },
    {
      path: 'insights/roles.md',
      title: 'Assistant and roles',
      summary: 'Who does what.',
      modifiedAt: '2026-10-01T00:00:00.000Z',
      links: ['insights/nav.md'],
      linkedFrom: [],
    },
  ],
  index: {
    path: 'insights/index.md',
    modifiedAt: today,
    overview: 'Start with the [navigation concept](nav.md).',
    topics: [
      {
        title: 'Product concept',
        description: 'Assistant, roles',
        pages: ['insights/nav.md', 'insights/roles.md'],
      },
    ],
  },
  decisions: [
    {
      id: 'b'.repeat(32),
      path: DECISION_B,
      title: 'Content lists Wiki and Sources',
      createdAt: today,
      status: 'current',
      predecessor: 'a'.repeat(32),
    },
    {
      id: 'a'.repeat(32),
      path: DECISION_A,
      title: 'Knowledge is one entry',
      createdAt: '2026-11-03T00:00:00.000Z',
      status: 'superseded',
      successor: 'b'.repeat(32),
    },
  ],
  review: [
    { kind: 'edit_conflict', path: 'insights/nav.md', conflict: 'insights/Conflicts/c1' },
    { kind: 'broken_links', path: 'insights/roles.md', targets: ['insights/gone.md'] },
  ],
  truncated: false,
};

function client(wiki: WikiCatalog | null = catalog, extra: Record<string, unknown> = {}) {
  const value = {
    getProjectWiki: jest.fn().mockResolvedValue(wiki),
    listProjectKnowledgeFiles: jest.fn().mockResolvedValue({
      root: 'knowledge',
      path: 'insights',
      entries: [
        { path: 'insights/decisions', name: 'decisions', kind: 'directory' },
        { path: 'insights/nav.md', name: 'nav.md', kind: 'file' },
      ],
      truncated: false,
    }),
    getProjectKnowledgeFile: jest.fn(),
    ...extra,
  };
  mockCreateVerityClient.mockReturnValue(value as unknown as VerityClient);
  return value;
}

beforeEach(() => {
  resetSettingsHarness();
  invalidateWikiCatalog('p');
});

it('addresses the Wiki views like folders, so back goes to the start page', () => {
  expect(wikiView(PROJECT, 'insights')).toEqual({ kind: 'home' });
  expect(wikiView(PROJECT, DECISIONS)).toEqual({ kind: 'decisions' });
  expect(wikiView(PROJECT, WIKI_FILES)).toEqual({ kind: 'files' });
  expect(wikiView(PROJECT, topicFolder('A/B & C'))).toEqual({ kind: 'topic', title: 'A/B & C' });
  // The router hands params back decoded; the folder must survive that, and a
  // title must not split into folders or name a parent other than the Wiki.
  for (const title of ['100% done', 'A/B', 'Über ✓', '~7e.'])
    expect(wikiView(PROJECT, decodeURIComponent(topicFolder(title)))).toEqual({
      kind: 'topic',
      title,
    });
  expect(topicFolder('A/B')).not.toContain('/B');
  expect(folderTitle(PROJECT, topicFolder('A/B & C'))).toBe('A/B & C');
  expect(folderTitle(PROJECT, WIKI_FILES)).toBe('All files');
  // Shared has no Wiki catalog; its folders stay folders.
  expect(wikiView({ kind: 'shared' }, 'insights')).toBeNull();
});

it('opens the Wiki on its start page, built from the catalog', async () => {
  const api = client();
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByTestId('wiki-home')).toBeTruthy();
  // The start page is the catalog, not a folder listing.
  expect(api.listProjectKnowledgeFiles).not.toHaveBeenCalled();
  expect(screen.getByText('Product concept')).toBeTruthy();
  expect(screen.getByText('Assistant, roles · 2 pages')).toBeTruthy();
  // Current decisions first; the superseded one only behind its chip.
  expect(screen.getByText('Content lists Wiki and Sources')).toBeTruthy();
  expect(screen.queryByText('Knowledge is one entry')).toBeNull();
  expect(screen.getByText(/replaces “Knowledge is one entry”/)).toBeTruthy();
  expect(screen.getByText('Current')).toBeTruthy();
  expect(screen.getByText('To review · 2')).toBeTruthy();
  expect(screen.getByText('Navigation concept · changed twice at once')).toBeTruthy();
  expect(screen.getByText('1 broken link')).toBeTruthy();

  fireEvent.press(screen.getByText('Product concept'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', folder: topicFolder('Product concept') },
  });
  fireEvent.press(screen.getByText('All 2 decisions'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', folder: DECISIONS },
  });
  fireEvent.press(screen.getByText('All files'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', folder: WIKI_FILES },
  });
  // A link in the overview opens its page.
  fireEvent.press(screen.getByText('navigation concept'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', file: 'insights/nav.md' },
  });
});

it('lists every page by title where the Wiki has no start page yet', async () => {
  client({ ...catalog, index: null });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText('Pages · 2')).toBeTruthy();
  // Each page by its title with its first paragraph, not by its file name.
  expect(screen.getByText('Who does what.')).toBeTruthy();
  expect(screen.queryByText('roles.md')).toBeNull();
  expect(screen.queryByText('Topics')).toBeNull();
});

// A Wiki is set up in a session with the user, never written on opening: the
// buttons must start that session with the setup request, not write anything.
it('explains an empty Wiki and sets it up in a session', async () => {
  const api = client({ ...catalog, pages: [], index: null, decisions: [], review: [] });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByTestId('wiki-empty')).toBeTruthy();
  expect(screen.getByText('You confirm every change')).toBeTruthy();
  fireEvent.press(screen.getByText('Set up Wiki'));
  const call = mockPush.mock.calls.at(-1)?.[0] as unknown as {
    pathname: string;
    params: { projectId: string; prompt: string };
  };
  expect(call.pathname).toBe('/new');
  expect(call.params.projectId).toBe('p');
  expect(call.params.prompt).toContain('wiki-maintain');
  expect(call.params.prompt).toContain('write nothing until I confirm');
  expect(api.getProjectKnowledgeFile).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Add a source first'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', folder: 'sources' },
  });
});

it('offers an overview above the pages of a Wiki without a start page', async () => {
  client({ ...catalog, index: null });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText('2 pages, no overview yet')).toBeTruthy();
  fireEvent.press(screen.getByText('Create overview'));
  const call = mockPush.mock.calls.at(-1)?.[0] as unknown as { params: { prompt: string } };
  expect(call.params.prompt).toMatch(/^Create a start page/);
  // The pages stay listed under the offer.
  expect(screen.getByText('Pages · 2')).toBeTruthy();
});

// The badge leads to To review; buried under the decisions it would be missed.
it('shows what needs a look right under the overview', async () => {
  client();
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  await screen.findByTestId('wiki-home');
  const text = JSON.stringify(screen.toJSON());
  expect(text.indexOf('To review · 2')).toBeLessThan(text.indexOf('Topics'));
  expect(text.indexOf('To review · 2')).toBeGreaterThan(text.indexOf('navigation concept'));
});

it('names where a page’s latest change came from, newest log entry first', async () => {
  const daysAgo = (days: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString();
  };
  client({
    ...catalog,
    pages: [
      { ...catalog.pages[0]!, modifiedAt: daysAgo(3) },
      {
        ...catalog.pages[1]!,
        // Older on disk, but the log names it later: it is the latest change.
        lastChange: { at: daysAgo(1).slice(0, 10), kind: 'ingest', title: 'Live meeting 2 Jan' },
      },
    ],
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  const from = await screen.findByText(/from Live meeting 2 Jan/);
  expect(from).toBeTruthy();
  const text = JSON.stringify(screen.toJSON());
  const recent = text.slice(text.indexOf('Recently updated'));
  expect(recent.indexOf('Assistant and roles')).toBeLessThan(recent.indexOf('Navigation concept'));
});

// An edit outside the log (an admin edit, a resolved conflict) is newer than the
// log entry; the page must not keep the stale entry's day and origin.
it('prefers a later edit of the file over an older log entry', async () => {
  client({
    ...catalog,
    pages: [
      {
        ...catalog.pages[0]!,
        lastChange: { at: '2020-01-01', kind: 'ingest', title: 'Old meeting' },
      },
      catalog.pages[1]!,
    ],
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  await screen.findByTestId('wiki-home');
  expect(screen.queryByText(/from Old meeting/)).toBeNull();
});

// The log's day is the writer's, so an entry one day older than the file still
// stands; two days older, the file was edited after it.
it('keeps a log entry one day older than the file, not two', async () => {
  const day = (offset: number) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  client({
    ...catalog,
    pages: [
      { ...catalog.pages[0]!, lastChange: { at: day(-1), kind: 'ingest', title: 'Yesterday' } },
      {
        ...catalog.pages[1]!,
        modifiedAt: today,
        lastChange: { at: day(-2), kind: 'chat', title: 'Earlier' },
      },
    ],
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText(/from Yesterday/)).toBeTruthy();
  expect(screen.queryByText(/from Earlier/)).toBeNull();
});

it('ignores a log entry dated in the future', async () => {
  client({
    ...catalog,
    pages: [
      { ...catalog.pages[0]!, lastChange: { at: '2999-01-01', kind: 'ingest', title: 'Future' } },
      catalog.pages[1]!,
    ],
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  await screen.findByTestId('wiki-home');
  expect(screen.queryByText(/from Future/)).toBeNull();
});

it('explains how the Wiki works and links its rules and change log', async () => {
  client({
    ...catalog,
    conventions: { path: 'insights/wiki-conventions.md', modifiedAt: today },
    log: { path: 'insights/log.md', modifiedAt: today },
  });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  await screen.findByTestId('wiki-home');
  fireEvent.press(screen.getByLabelText('How the Wiki works'));
  expect(await screen.findByText('Verity writes and maintains')).toBeTruthy();
  expect(screen.getByText('How this Wiki is organized')).toBeTruthy();
  fireEvent.press(screen.getByText('Change log'));
  expect(mockPush).toHaveBeenLastCalledWith({
    pathname: '/project/[id]/knowledge',
    params: { id: 'p', file: 'insights/log.md' },
  });
  fireEvent.press(screen.getByLabelText('How the Wiki works'));
  fireEvent.press(await screen.findByText('Rebuild overview…'));
  const call = mockPush.mock.calls.at(-1)?.[0] as unknown as { params: { prompt: string } };
  expect(call.params.prompt).toMatch(/^Rebuild the start page/);
});

it('lists decisions by status, superseded ones on request', async () => {
  client();
  render(<KnowledgeScreen scope={PROJECT} folder={DECISIONS} />);
  expect(await screen.findByTestId('wiki-decisions')).toBeTruthy();
  expect(screen.queryByText('Knowledge is one entry')).toBeNull();
  fireEvent.press(screen.getByText('Superseded · 1'));
  expect(screen.getByText('Knowledge is one entry')).toBeTruthy();
  expect(screen.queryByText('Content lists Wiki and Sources')).toBeNull();
});

it('shows a topic’s pages and the Wiki’s files by their titles', async () => {
  const api = client();
  const { unmount } = render(
    <KnowledgeScreen scope={PROJECT} folder={topicFolder('Product concept')} />,
  );
  expect(await screen.findByText('Assistant and roles')).toBeTruthy();
  expect(screen.getByText('What the project page shows.')).toBeTruthy();
  unmount();
  render(<KnowledgeScreen scope={PROJECT} folder={WIKI_FILES} />);
  expect(await screen.findByText('Navigation concept')).toBeTruthy();
  expect(screen.queryByText('nav.md')).toBeNull();
  expect(api.listProjectKnowledgeFiles).toHaveBeenCalledWith('p', 'insights');
});

it('falls back to the folder from a server without a catalog', async () => {
  const api = client(null);
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText('nav.md')).toBeTruthy();
  expect(screen.queryByTestId('wiki-home')).toBeNull();
  expect(api.listProjectKnowledgeFiles).toHaveBeenCalledWith('p', 'insights');
});

describe('a Wiki page', () => {
  const page = (content: string, path = 'insights/nav.md') => {
    const openFile = jest.fn();
    const api = client(catalog, {
      getProjectKnowledgeFile: jest.fn().mockResolvedValue({
        path,
        content,
        editable: true,
        version: 'a'.repeat(64),
        size: content.length,
      }),
    });
    render(
      <KnowledgePaneContext.Provider value={{ openFile }}>
        <KnowledgeFileView
          client={api as unknown as VerityClient}
          scope={PROJECT}
          file={path}
          chrome="pane"
        />
      </KnowledgePaneContext.Provider>,
    );
    return openFile;
  };

  it('reads as a page and opens what it links to in the app', async () => {
    const openFile = page(
      [
        '# Navigation concept',
        '',
        'See [roles](roles.md), [the decision](decisions/' + 'b'.repeat(32) + '.md),',
        '[the web](https://example.com) and [outside](../../etc/passwd).',
      ].join('\n'),
    );
    expect(await screen.findByText('Topic · Product concept · updated today')).toBeTruthy();
    // The pane's header and the page each name it; the Markdown's own title line
    // is not shown a third time.
    expect(screen.getAllByText('Navigation concept')).toHaveLength(2);
    fireEvent.press(screen.getByText('roles'));
    expect(openFile).toHaveBeenLastCalledWith(PROJECT, 'insights/roles.md');
    fireEvent.press(screen.getByText('the decision'));
    expect(openFile).toHaveBeenLastCalledWith(PROJECT, DECISION_B);
    // A path out of the knowledge is text, not a link.
    expect(screen.getByText('outside').props.onPress).toBeUndefined();
    // What it links to and what links here, below the page.
    expect(screen.getByText('Decisions')).toBeTruthy();
    expect(screen.getByText('Sources')).toBeTruthy();
    expect(screen.getByText('2026-11-07-live-meeting')).toBeTruthy();
    expect(screen.getByText('Linked from · 1')).toBeTruthy();
    fireEvent.press(screen.getByText('Assistant and roles'));
    expect(openFile).toHaveBeenLastCalledWith(PROJECT, 'insights/roles.md');
  });

  it('leaves out sections it has nothing for', async () => {
    page('# Assistant and roles\n\nNo links.', 'insights/roles.md');
    expect(await screen.findByText('No links.')).toBeTruthy();
    expect(screen.queryByText('Decisions')).toBeNull();
    expect(screen.queryByText('Sources')).toBeNull();
    expect(screen.queryByText(/^Linked from/)).toBeNull();
  });

  it('shows a decision’s status and its revisions, without the metadata line', async () => {
    page(`<!-- verity-decision:v1 {"id":"x"} -->\n# Knowledge is one entry\n\nBody.`, DECISION_A);
    expect(await screen.findByText('Superseded')).toBeTruthy();
    expect(screen.getByText('Revisions')).toBeTruthy();
    expect(screen.getByText('Content lists Wiki and Sources')).toBeTruthy();
    expect(screen.queryByText(/verity-decision/)).toBeNull();
  });
});

it('drops one-line comments from rendered Markdown, not from the text around them', () => {
  expect(
    fileMarkdownItems('<!-- meta -->\n# T\n<!-- a --> kept <!-- b -->\n<!-- open\nstill -->'),
  ).toEqual([
    { type: 'line', content: '# T' },
    { type: 'line', content: '<!-- a --> kept <!-- b -->' },
    { type: 'line', content: '<!-- open' },
    { type: 'line', content: 'still -->' },
  ]);
});

it('lists the Wiki’s files when its catalog fails to load, with Retry', async () => {
  const api = client(catalog, { getProjectWiki: jest.fn().mockRejectedValue(new Error('down')) });
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText(/view could not be loaded \(down\)/)).toBeTruthy();
  // The Wiki stays reachable through its files.
  expect(await screen.findByText('nav.md')).toBeTruthy();
  api.getProjectWiki.mockResolvedValue(catalog);
  await act(async () => fireEvent.press(screen.getByText('Retry')));
  expect(await screen.findByTestId('wiki-home')).toBeTruthy();
});

it('reads the catalog again on screens already open when the Wiki changes', async () => {
  const api = client();
  render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
  expect(await screen.findByText('Product concept')).toBeTruthy();
  api.getProjectWiki.mockResolvedValue({
    ...catalog,
    index: { ...catalog.index!, topics: [{ title: 'Renamed', description: '', pages: [] }] },
  });
  await act(async () => invalidateWikiCatalog('p'));
  expect(await screen.findByText('Renamed')).toBeTruthy();
});

it('never shows one project’s catalog for another', async () => {
  const api = client();
  const view = (projectId: string) => (
    <KnowledgeScreen scope={{ kind: 'project', projectId }} folder="insights" />
  );
  const { rerender } = render(view('p'));
  expect(await screen.findByText('Product concept')).toBeTruthy();
  let finish: (value: WikiCatalog) => void = () => undefined;
  api.getProjectWiki.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  rerender(view('q'));
  await act(async () => undefined);
  expect(screen.queryByText('Product concept')).toBeNull();
  await act(async () => finish({ ...catalog, index: null }));
  expect(await screen.findByText('Pages · 2')).toBeTruthy();
});

it('opens the decision list on a group that has decisions in it', async () => {
  client({
    ...catalog,
    decisions: catalog.decisions.map((decision) => ({
      ...decision,
      status: 'superseded' as const,
    })),
  });
  render(<KnowledgeScreen scope={PROJECT} folder={DECISIONS} />);
  expect(await screen.findByText('Knowledge is one entry')).toBeTruthy();
});

it('moves off a decision group that the Wiki emptied', async () => {
  const api = client();
  render(<KnowledgeScreen scope={PROJECT} folder={DECISIONS} />);
  fireEvent.press(await screen.findByText('Superseded · 1'));
  expect(screen.getByText('Knowledge is one entry')).toBeTruthy();
  api.getProjectWiki.mockResolvedValue({
    ...catalog,
    decisions: catalog.decisions.filter((decision) => decision.status === 'current'),
  });
  await act(async () => invalidateWikiCatalog('p'));
  expect(await screen.findByText('Content lists Wiki and Sources')).toBeTruthy();
});

it('says a date inside a sentence without lowering the month', () => {
  expect(wikiDayInline(new Date().toISOString())).toBe('today');
  expect(wikiDayInline('2020-11-07T12:00:00.000Z')).toBe('7 Nov 2020');
  expect(wikiDayInline('not a date')).toBe('at an unknown time');
});

describe('proposed Wiki changes', () => {
  const head = {
    id: 'a1',
    mode: 'inline' as const,
    logKind: 'chat',
    title: 'Billing cycle',
    sources: ['sources/meetings/2026-11-07-live-meeting.md'],
    createdAt: today,
    decidedAt: null,
  };
  const pending = { status: 'pending' as const, stale: false };

  it('lists proposals first under To review and opens one for review', async () => {
    client(catalog, {
      listWikiProposals: jest
        .fn()
        .mockResolvedValue([
          { ...head, changes: [{ ...pending, path: 'nav.md', summary: 'Explain billing' }] },
        ]),
    });
    render(<KnowledgeScreen scope={PROJECT} folder="insights" />);
    fireEvent.press(await screen.findByText('Billing cycle'));
    expect(screen.getByText('To review · 3')).toBeTruthy();
    expect(screen.getByText('1 change · prepared today')).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ proposal: 'a1' }) }),
    );
  });

  // Leaving a page out must not apply it, and a page edited since the proposal
  // must not be offered for applying at all.
  it('applies the chosen pages and rejects the ones left out', async () => {
    const decideWikiProposal = jest.fn().mockResolvedValue({ applied: [], stale: [], failed: [] });
    client(catalog, {
      getWikiProposal: jest.fn().mockResolvedValue({
        ...head,
        changes: [
          {
            ...pending,
            path: 'nav.md',
            summary: 'Explain billing',
            current: 'Intro.\n\nOld step.',
            content: 'Intro.\n\nNew step.',
          },
          { ...pending, path: 'faq.md', summary: 'Add FAQ', current: null, content: '# FAQ' },
          {
            ...pending,
            stale: true,
            path: 'roles.md',
            summary: 'Rename roles',
            current: 'x',
            content: 'y',
          },
        ],
      }),
      decideWikiProposal,
    });
    render(<KnowledgeScreen scope={PROJECT} proposal="a1" />);
    expect(await screen.findByText('Old step.')).toBeTruthy();
    expect(screen.getByText('New step.')).toBeTruthy();
    expect(screen.getByText('Changes · 2 of 3 selected')).toBeTruthy();
    fireEvent.press(screen.getByText('faq · Add FAQ'));
    fireEvent.press(screen.getByText('Apply 1 change'));
    await act(async () => {});
    expect(decideWikiProposal).toHaveBeenCalledWith('p', 'a1', 'apply', ['nav.md']);
    expect(decideWikiProposal).toHaveBeenCalledWith('p', 'a1', 'reject', ['faq.md', 'roles.md']);
  });
});
