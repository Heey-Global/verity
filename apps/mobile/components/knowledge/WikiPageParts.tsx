import type { WikiCatalog } from '@verity/mobile';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Group, Row, SectionHeader, Text } from '../ui';
import { catalogTitle, DecisionRow, DecisionStatus, PageRow, wikiDay } from './WikiViews';

/** What the catalog knows about one knowledge file: a page or a decision. */
export function wikiEntry(catalog: WikiCatalog | null | undefined, file: string) {
  if (!catalog) return undefined;
  const page = catalog.pages.find((candidate) => candidate.path === file);
  if (page) return { kind: 'page' as const, page };
  const decision = catalog.decisions.find((candidate) => candidate.path === file);
  if (decision) return { kind: 'decision' as const, decision };
  return undefined;
}

/** The title, and one line saying where the page belongs and how old it is. */
export function WikiPageHeader({ catalog, file }: { catalog: WikiCatalog; file: string }) {
  const entry = wikiEntry(catalog, file);
  if (!entry) return null;
  if (entry.kind === 'decision')
    return (
      <View style={styles.head}>
        <Text variant="title">{entry.decision.title}</Text>
        <View style={styles.status}>
          <DecisionStatus status={entry.decision.status} />
          <Text variant="footnote" tone="muted">
            {`Decision · recorded ${wikiDay(entry.decision.createdAt).toLowerCase()}`}
          </Text>
        </View>
      </View>
    );
  const topic = catalog.index?.topics.find((candidate) => candidate.pages.includes(file));
  return (
    <View style={styles.head}>
      <Text variant="title">{entry.page.title}</Text>
      <Text variant="footnote" tone="muted">
        {[
          topic ? `Topic · ${topic.title}` : '',
          `updated ${wikiDay(entry.page.modifiedAt).toLowerCase()}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
}

/**
 * What the page is connected to: the decisions and sources it links, a
 * decision's place in its revision chain, and the pages that link here. Each
 * section exists only when it has something to show.
 */
export function WikiPageFooter({
  catalog,
  file,
  onOpen,
}: {
  catalog: WikiCatalog;
  file: string;
  onOpen: (file: string) => void;
}) {
  const entry = wikiEntry(catalog, file);
  if (!entry) return null;
  const links = entry.kind === 'page' ? entry.page.links : [];
  const decisions = [
    ...(entry.kind === 'decision'
      ? [
          ...catalog.decisions.filter((other) => other.id === entry.decision.predecessor),
          ...catalog.decisions.filter((other) => other.id === entry.decision.successor),
        ]
      : catalog.decisions.filter((decision) => links.includes(decision.path))),
  ];
  const sources = links.filter((path) => path.startsWith('sources/'));
  const linkedFrom =
    entry.kind === 'page'
      ? entry.page.linkedFrom
      : catalog.pages.filter((page) => page.links.includes(file)).map((page) => page.path);
  return (
    <View style={styles.footer}>
      {decisions.length ? (
        <>
          <SectionHeader title={entry.kind === 'decision' ? 'Revisions' : 'Decisions'} />
          <Group>
            {decisions.map((decision) => (
              <DecisionRow
                key={decision.id}
                decision={decision}
                catalog={catalog}
                onOpen={onOpen}
              />
            ))}
          </Group>
        </>
      ) : null}
      {sources.length ? (
        <>
          <SectionHeader title="Sources" />
          <Group>
            {sources.map((path) => {
              const meeting = path.startsWith('sources/meetings/');
              return (
                <Row
                  key={path}
                  leading={{ icon: meeting ? 'mic' : 'paperclip' }}
                  title={(path.split('/').at(-1) ?? path).replace(/\.md$/i, '')}
                  subtitle={meeting ? 'Meeting transcript' : 'Document'}
                  navigates
                  onPress={() => onOpen(path)}
                />
              );
            })}
          </Group>
        </>
      ) : null}
      {linkedFrom.length ? (
        <>
          <SectionHeader title={`Linked from · ${String(linkedFrom.length)}`} />
          <Group>
            {linkedFrom.map((path) => {
              const page = catalog.pages.find((candidate) => candidate.path === path);
              return page ? (
                <PageRow key={path} page={page} onOpen={onOpen} />
              ) : (
                <Row
                  key={path}
                  leading={{ icon: 'file-text' }}
                  title={catalogTitle(catalog, path)}
                  navigates
                  onPress={() => onOpen(path)}
                />
              );
            })}
          </Group>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: { gap: theme.spacing.xs, paddingBottom: theme.spacing.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm },
  footer: { gap: theme.spacing.md, paddingTop: theme.spacing.lg },
}));
