import {
  resolveKnowledgeLink,
  type WikiCatalog,
  type WikiDecision,
  type WikiPage,
  type WikiProposalSummary,
  type WikiReviewItem,
} from '@verity/mobile';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { KnowledgeEntryActions } from './KnowledgeEntryActions';
import { MarkdownItem } from '../files/MarkdownItem';
import {
  Button,
  Card,
  CardHead,
  FilterChips,
  Group,
  Row,
  SectionHeader,
  StatusTag,
  StepIntro,
  Text,
} from '../ui';
import { fileMarkdownItems } from '../../lib/fileMarkdownPreview';
import { DECISIONS, topicFolder, WIKI_FILES } from './knowledgeScope';
import { WikiRoles, type WikiSetupMode } from './WikiGuide';

/** How many decisions and recent pages the start page shows before "All". */
const DECISIONS_SHOWN = 3;
const RECENT_SHOWN = 5;

type Open = {
  folder: (folder: string) => void;
  file: (file: string) => void;
  /** Opens a proposed change for review; absent where it cannot be reviewed. */
  proposal?: (id: string) => void;
};

/**
 * The log entry behind a page's latest change, when the page was not edited
 * again after it (an edit outside the log makes the entry stale).
 */
function currentChange(page: WikiPage): WikiPage['lastChange'] {
  const change = page.lastChange;
  // An entry dated past tomorrow (UTC) was written wrong; it must not pin the page on top.
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (change && change.at > tomorrow.toISOString().slice(0, 10)) return undefined;
  const edited = new Date(page.modifiedAt);
  if (!change || Number.isNaN(edited.getTime())) return change;
  // The entry's day is the writer's; a publish past midnight may land a day later.
  edited.setUTCDate(edited.getUTCDate() - 1);
  return change.at >= edited.toISOString().slice(0, 10) ? change : undefined;
}

/** When a page last changed: its current log entry, else its file age. */
function changedAt(page: WikiPage): string {
  const change = currentChange(page);
  // A log day is read at noon UTC, so no time zone moves it to another day.
  return change ? `${change.at}T12:00:00.000Z` : page.modifiedAt;
}

/** {@link changedAt} as a number, so log days and file times sort together. */
function changedTime(page: WikiPage): number {
  const time = Date.parse(changedAt(page));
  return Number.isNaN(time) ? 0 : time;
}

/** "today", "yesterday" or the date, inside a sentence ("updated today"). */
export function wikiDayInline(iso: string): string {
  const day = wikiDay(iso);
  return day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day || 'at an unknown time';
}

/** "Today", "Yesterday" or the date, as lists of changes say it. */
function wikiDay(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const key = (value: Date) => value.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key(date) === key(now)) return 'Today';
  if (key(date) === key(yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** A decision's status as the tag beside it. */
export function DecisionStatus({ status }: { status: WikiDecision['status'] }) {
  if (status === 'current') return <StatusTag intent="ready" label="Current" />;
  if (status === 'superseded') return <StatusTag intent="optional" label="Superseded" />;
  return <StatusTag intent="needsSetup" label="Unresolved" />;
}

export function DecisionRow({
  decision,
  catalog,
  onOpen,
}: {
  decision: WikiDecision;
  catalog: WikiCatalog;
  onOpen: (file: string) => void;
}) {
  const replaces = decision.predecessor
    ? catalog.decisions.find((other) => other.id === decision.predecessor)
    : undefined;
  return (
    <Row
      leading={{ icon: 'check-circle' }}
      title={decision.title}
      subtitle={[wikiDay(decision.createdAt), replaces ? `replaces “${replaces.title}”` : '']
        .filter(Boolean)
        .join(' · ')}
      trailing={<DecisionStatus status={decision.status} />}
      navigates
      onPress={() => onOpen(decision.path)}
    />
  );
}

export function PageRow({
  page,
  subtitle,
  onOpen,
}: {
  page: WikiPage;
  subtitle?: string;
  onOpen: (file: string) => void;
}) {
  return (
    <KnowledgeEntryActions path={page.path} label={page.title}>
      <Row
        leading={{ icon: 'file-text' }}
        title={page.title}
        subtitle={subtitle ?? (page.summary || undefined)}
        navigates
        onPress={() => onOpen(page.path)}
      />
    </KnowledgeEntryActions>
  );
}

type DecisionFilter = WikiDecision['status'];

function useDecisionFilter(decisions: WikiDecision[]) {
  const counts = useMemo(() => {
    const result: Record<DecisionFilter, number> = { current: 0, superseded: 0, unresolved: 0 };
    for (const decision of decisions) result[decision.status]++;
    return result;
  }, [decisions]);
  const [chosen, setFilter] = useState<DecisionFilter>('current');
  // A chosen group that is empty, at first or after the Wiki changed, gives way
  // to the first group with something in it, so the list never shows empty.
  const filter =
    counts[chosen] > 0
      ? chosen
      : ((['current', 'unresolved', 'superseded'] as const).find((status) => counts[status] > 0) ??
        chosen);
  const options = [
    { value: 'current' as const, label: `Current · ${String(counts.current)}` },
    { value: 'superseded' as const, label: `Superseded · ${String(counts.superseded)}` },
    ...(counts.unresolved
      ? [{ value: 'unresolved' as const, label: `Unresolved · ${String(counts.unresolved)}` }]
      : []),
  ];
  const chips = (
    <FilterChips
      options={options}
      value={filter}
      onChange={setFilter}
      accessibilityLabel="Decisions"
      compact
    />
  );
  return { chips, shown: decisions.filter((decision) => decision.status === filter) };
}

function reviewRow(item: WikiReviewItem, title: (path: string) => string, open: Open) {
  if (item.kind === 'edit_conflict')
    return (
      <Row
        key={`${item.kind}:${item.conflict}`}
        leading={{ icon: 'git-merge', intent: 'needsSetup' }}
        title="Edit conflict"
        subtitle={`${title(item.path)} · changed twice at once`}
        navigates
        onPress={() => open.folder(item.conflict)}
      />
    );
  const count = item.targets.length;
  return (
    <Row
      key={`${item.kind}:${item.path}`}
      leading={{ icon: 'link-2', intent: 'needsSetup' }}
      title={`${String(count)} broken ${count === 1 ? 'link' : 'links'}`}
      subtitle={title(item.path)}
      navigates
      onPress={() => open.file(item.path)}
    />
  );
}

/** Where a proposal came from, as its row's icon: a meeting, a chat, or upkeep. */
function proposalIcon(proposal: WikiProposalSummary) {
  if (proposal.sources.some((source) => /(^|\/)sources\/meetings\//.test(source))) return 'mic';
  return proposal.mode === 'inline' ? 'message-circle' : 'book-open';
}

/** "2 changes on 2 pages · prepared today", or that its pages changed since. */
function proposalSubtitle(proposal: WikiProposalSummary): string {
  const pending = proposal.changes.filter((change) => change.status === 'pending');
  const stale = pending.filter((change) => change.stale).length;
  const count = `${String(pending.length)} ${pending.length === 1 ? 'change' : 'changes'}`;
  const state =
    stale === pending.length && stale > 0
      ? 'page changed since'
      : `prepared ${wikiDayInline(proposal.createdAt)}`;
  return `${count} · ${state}`;
}

function proposalRow(proposal: WikiProposalSummary, open: Open) {
  const review = open.proposal;
  return (
    <Row
      key={`proposal:${proposal.id}`}
      leading={{ icon: proposalIcon(proposal) }}
      title={proposal.title}
      subtitle={proposalSubtitle(proposal)}
      {...(review ? { navigates: true, onPress: () => review(proposal.id) } : {})}
    />
  );
}

/** A page's title from the catalog, or its file name where the catalog has none. */
export function catalogTitle(catalog: WikiCatalog, path: string): string {
  return (
    catalog.pages.find((page) => page.path === path)?.title ??
    catalog.decisions.find((decision) => decision.path === path)?.title ??
    (catalog.index?.path === path ? 'Start page' : (path.split('/').at(-1) ?? path))
  );
}

/**
 * A Wiki without pages or decisions: what it is for and who does what, then
 * setting it up in a session. Nothing is written before the user confirms there.
 */
function WikiEmpty({ open, setup }: { open: Open; setup?: (mode: WikiSetupMode) => void }) {
  return (
    <View style={styles.root} testID="wiki-empty">
      <StepIntro
        headline="Your project,"
        accent="explained."
        lead="The Wiki answers what this project is, how it works and why things were decided, without digging through old chats."
      />
      <WikiRoles />
      <View style={styles.setup}>
        {setup ? (
          <>
            <Button label="Set up Wiki" icon="book-open" onPress={() => setup('setup')} fullWidth />
            <Text variant="footnote" tone="muted" style={styles.center}>
              Verity asks two short questions in a session, then proposes the first topics.
            </Text>
          </>
        ) : null}
        <View style={setup ? styles.secondary : undefined}>
          <Button
            label="Add a source first"
            variant="secondary"
            onPress={() => open.folder('sources')}
            fullWidth
          />
        </View>
      </View>
    </View>
  );
}

/**
 * The Wiki's start page: the overview and topics Verity maintains in index.md,
 * what needs a look right under it, then what the app reads itself — decisions
 * with their status and the pages changed last, named by where the change came
 * from. Without index.md every page is listed by its title, below the offer to
 * create the overview; a Wiki with nothing in it explains itself instead.
 */
export function WikiHome({
  catalog,
  open,
  setup,
  proposals = [],
}: {
  catalog: WikiCatalog;
  open: Open;
  /** Proposed changes waiting for review, listed first under To review. */
  proposals?: readonly WikiProposalSummary[];
  /** Starts a setup session; absent where the Wiki cannot be set up from here. */
  setup?: (mode: WikiSetupMode) => void;
}) {
  const { chips, shown } = useDecisionFilter(catalog.decisions);
  const title = (path: string) => catalogTitle(catalog, path);
  const index = catalog.index;
  const overview = useMemo(() => (index ? fileMarkdownItems(index.overview) : []), [index]);
  const openLink = (url: string) => {
    const target = resolveKnowledgeLink(index?.path ?? 'insights/index.md', url);
    return target ? () => open.file(target) : undefined;
  };
  const recent = [...catalog.pages]
    .sort((a, b) => changedTime(b) - changedTime(a))
    .slice(0, RECENT_SHOWN);
  // A catalog cut short may hide pages; it shows its notice and All files instead.
  const empty =
    !index &&
    !catalog.pages.length &&
    !catalog.decisions.length &&
    !catalog.review.length &&
    !proposals.length &&
    !catalog.truncated;
  if (empty) return <WikiEmpty open={open} {...(setup ? { setup } : {})} />;
  const toReview = proposals.length + catalog.review.length;
  const review = toReview ? (
    <>
      <SectionHeader title={`To review · ${String(toReview)}`} />
      <Group>
        {proposals.map((proposal) => proposalRow(proposal, open))}
        {catalog.review.map((item) => reviewRow(item, title, open))}
      </Group>
    </>
  ) : null;
  const topicOf = (path: string) => index?.topics.find((topic) => topic.pages.includes(path));
  return (
    <View style={styles.root} testID="wiki-home">
      {index ? (
        <Card stacked>
          {overview.map((item, position) => (
            <MarkdownItem key={position} item={item} openLink={openLink} />
          ))}
          <Pressable
            onPress={() => open.file(index.path)}
            accessibilityRole="button"
            accessibilityLabel="Open the start page"
          >
            <Text variant="footnote" tone="muted">
              {`Start page · updated ${wikiDayInline(index.modifiedAt)}`}
            </Text>
          </Pressable>
        </Card>
      ) : setup && catalog.pages.length ? (
        <Card stacked>
          <CardHead
            title={`${String(catalog.pages.length)} ${catalog.pages.length === 1 ? 'page' : 'pages'}, no overview yet`}
          />
          <Text variant="bodySmall" tone="muted">
            A start page explains the project and groups these pages into topics. Verity asks two
            questions first, reads the pages and names gaps instead of filling them.
          </Text>
          <View style={styles.setup}>
            <Button label="Create overview" onPress={() => setup('overview')} fullWidth />
            <Text variant="footnote" tone="muted" style={styles.center}>
              Opens a session · nothing is written until you confirm
            </Text>
          </View>
        </Card>
      ) : null}

      {review}

      {index?.topics.length ? (
        <>
          <SectionHeader title="Topics" />
          <Group>
            {index.topics.map((topic) => {
              const pages = `${String(topic.pages.length)} ${topic.pages.length === 1 ? 'page' : 'pages'}`;
              return (
                <Row
                  key={topic.title}
                  leading={{ icon: 'layers' }}
                  title={topic.title}
                  subtitle={topic.description ? `${topic.description} · ${pages}` : pages}
                  navigates
                  onPress={() => open.folder(topicFolder(topic.title))}
                />
              );
            })}
          </Group>
        </>
      ) : catalog.pages.length ? (
        <>
          <SectionHeader title={`Pages · ${String(catalog.pages.length)}`} />
          <Group>
            {[...catalog.pages]
              .sort((a, b) => a.title.localeCompare(b.title))
              .map((page) => (
                <PageRow key={page.path} page={page} onOpen={open.file} />
              ))}
          </Group>
        </>
      ) : (
        <Text variant="body" tone="muted">
          The Wiki has no pages yet.
        </Text>
      )}

      {catalog.decisions.length ? (
        <>
          <SectionHeader title="Decisions" />
          {chips}
          <Group>
            {shown.slice(0, DECISIONS_SHOWN).map((decision) => (
              <DecisionRow
                key={decision.id}
                decision={decision}
                catalog={catalog}
                onOpen={open.file}
              />
            ))}
            <Row
              title={`All ${String(catalog.decisions.length)} decisions`}
              navigates
              onPress={() => open.folder(DECISIONS)}
            />
          </Group>
        </>
      ) : null}

      {recent.length ? (
        <>
          <SectionHeader title="Recently updated" />
          <Group>
            {recent.map((page) => {
              const topic = topicOf(page.path);
              const change = currentChange(page);
              return (
                <PageRow
                  key={page.path}
                  page={page}
                  subtitle={[
                    wikiDay(changedAt(page)),
                    change ? `from ${change.title}` : topic?.title,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onOpen={open.file}
                />
              );
            })}
          </Group>
        </>
      ) : null}

      {catalog.truncated ? (
        <Text variant="subtitle" tone="muted">
          Some pages could not be read, so these lists may be incomplete. All files shows
          everything.
        </Text>
      ) : null}

      <View style={styles.footer}>
        <Group>
          <Row
            leading={{ icon: 'folder' }}
            title="All files"
            navigates
            onPress={() => open.folder(WIKI_FILES)}
          />
        </Group>
      </View>
    </View>
  );
}

/** Every decision, filtered by status, newest first. */
export function WikiDecisions({ catalog, open }: { catalog: WikiCatalog; open: Open }) {
  const { chips, shown } = useDecisionFilter(catalog.decisions);
  return (
    <View style={styles.root} testID="wiki-decisions">
      {catalog.decisions.length ? (
        <>
          {chips}
          <Group>
            {shown.map((decision) => (
              <DecisionRow
                key={decision.id}
                decision={decision}
                catalog={catalog}
                onOpen={open.file}
              />
            ))}
          </Group>
        </>
      ) : (
        <Text variant="body" tone="muted">
          No decisions recorded yet.
        </Text>
      )}
    </View>
  );
}

/** One topic of the start page: its description and its pages. */
export function WikiTopicPages({
  catalog,
  title,
  open,
}: {
  catalog: WikiCatalog;
  title: string;
  open: Open;
}) {
  const topic = catalog.index?.topics.find((candidate) => candidate.title === title);
  if (!topic)
    return (
      <Text variant="body" tone="muted" testID="wiki-topic">
        This topic is no longer on the start page.
      </Text>
    );
  return (
    <View style={styles.root} testID="wiki-topic">
      {topic.description ? (
        <Text variant="subtitle" tone="muted">
          {topic.description}
        </Text>
      ) : null}
      <Group>
        {topic.pages.map((path) => {
          const page = catalog.pages.find((candidate) => candidate.path === path);
          const decision = catalog.decisions.find((candidate) => candidate.path === path);
          if (decision)
            return (
              <DecisionRow key={path} decision={decision} catalog={catalog} onOpen={open.file} />
            );
          return page ? (
            <PageRow key={path} page={page} onOpen={open.file} />
          ) : (
            <Row
              key={path}
              leading={{ icon: 'file-text' }}
              title={catalogTitle(catalog, path)}
              subtitle="Page not found"
            />
          );
        })}
      </Group>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing.md },
  footer: { marginTop: theme.spacing.md },
  setup: { gap: theme.spacing.sm, marginTop: theme.spacing.sm },
  secondary: { marginTop: theme.spacing.md },
  center: { textAlign: 'center' },
}));
