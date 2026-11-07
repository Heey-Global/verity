import {
  resolveKnowledgeLink,
  type WikiCatalog,
  type WikiDecision,
  type WikiPage,
  type WikiReviewItem,
} from '@verity/mobile';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MarkdownItem } from '../files/MarkdownItem';
import { Card, FilterChips, Group, Row, SectionHeader, StatusTag, Text } from '../ui';
import { fileMarkdownItems } from '../../lib/fileMarkdownPreview';
import { DECISIONS, topicFolder, WIKI_FILES } from './knowledgeScope';

/** How many decisions and recent pages the start page shows before "All". */
const DECISIONS_SHOWN = 3;
const RECENT_SHOWN = 5;

type Open = { folder: (folder: string) => void; file: (file: string) => void };

/** "Today", "Yesterday" or the date, as lists of changes say it. */
export function wikiDay(iso: string, now = new Date()): string {
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
    <Row
      leading={{ icon: 'file-text' }}
      title={page.title}
      subtitle={subtitle ?? (page.summary || undefined)}
      navigates
      onPress={() => onOpen(page.path)}
    />
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

/** A page's title from the catalog, or its file name where the catalog has none. */
export function catalogTitle(catalog: WikiCatalog, path: string): string {
  return (
    catalog.pages.find((page) => page.path === path)?.title ??
    catalog.decisions.find((decision) => decision.path === path)?.title ??
    (catalog.index?.path === path ? 'Start page' : (path.split('/').at(-1) ?? path))
  );
}

/**
 * The Wiki's start page: the overview and topics Verity maintains in index.md,
 * then what the app reads itself — decisions with their status, the pages
 * changed last, and what needs a look. Without index.md every page is listed
 * by its title instead of the topics.
 */
export function WikiHome({ catalog, open }: { catalog: WikiCatalog; open: Open }) {
  const { chips, shown } = useDecisionFilter(catalog.decisions);
  const title = (path: string) => catalogTitle(catalog, path);
  const index = catalog.index;
  const overview = useMemo(() => (index ? fileMarkdownItems(index.overview) : []), [index]);
  const openLink = (url: string) => {
    const target = resolveKnowledgeLink(index?.path ?? 'insights/index.md', url);
    return target ? () => open.file(target) : undefined;
  };
  const recent = [...catalog.pages]
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, RECENT_SHOWN);
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
              {`Start page · updated ${wikiDay(index.modifiedAt).toLowerCase()}`}
            </Text>
          </Pressable>
        </Card>
      ) : null}

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
              return (
                <PageRow
                  key={page.path}
                  page={page}
                  subtitle={[wikiDay(page.modifiedAt), topic?.title].filter(Boolean).join(' · ')}
                  onOpen={open.file}
                />
              );
            })}
          </Group>
        </>
      ) : null}

      {catalog.review.length ? (
        <>
          <SectionHeader title={`To review · ${String(catalog.review.length)}`} />
          <Group>{catalog.review.map((item) => reviewRow(item, title, open))}</Group>
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
}));
