import { parseInline } from '@verity/mobile';
import { createContext, useContext } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { FileMarkdownItem } from '../../lib/fileMarkdownPreview';

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * What a local link in the document opens, if anything: the page that shows the
 * document answers with a press handler for links it can open in the app (a
 * Wiki page, a decision, a source) and with nothing for the rest, which stay
 * plain references.
 */
export type MarkdownLinkOpener = (url: string) => (() => void) | undefined;

const LinkOpenerContext = createContext<MarkdownLinkOpener | undefined>(undefined);

/** Bold, inline code and links inside one line. Web links open in the browser;
 *  a local link opens only where the page offers it. */
function Inline({ text }: { text: string }) {
  const openLocal = useContext(LinkOpenerContext);
  return (
    <>
      {parseInline(text).map((span, index) => {
        if (span.t === 'bold')
          return (
            <Text key={index} style={styles.bold}>
              {span.text}
            </Text>
          );
        if (span.t === 'code')
          return (
            <Text key={index} style={styles.inlineCode}>
              {span.text}
            </Text>
          );
        if (span.t === 'link') {
          const open = span.external ? undefined : openLocal?.(span.url);
          if (open)
            return (
              <Text key={index} style={styles.wikiLink} accessibilityRole="link" onPress={open}>
                {span.text}
              </Text>
            );
          return (
            <Text
              key={index}
              style={span.external ? styles.link : styles.reference}
              {...(span.external
                ? {
                    accessibilityRole: 'link' as const,
                    // Knowledge pages are written by agents and sources: only web
                    // links open, whatever the parser calls external.
                    onPress: () => {
                      if (/^https?:\/\//i.test(span.url)) void Linking.openURL(span.url);
                    },
                  }
                : {})}
            >
              {span.text}
            </Text>
          );
        }
        return span.text;
      })}
    </>
  );
}

/**
 * One item of a Markdown document for reading (knowledge pages): headings,
 * lists, quotes, rules, tables and code blocks in the app's type ramp. Items
 * come from `fileMarkdownItems`, which already bounds every text node, so a
 * long page renders as a list of small pieces.
 */
export function MarkdownItem({
  item,
  openLink,
}: {
  item: FileMarkdownItem;
  openLink?: MarkdownLinkOpener | undefined;
}) {
  if (openLink)
    return (
      <LinkOpenerContext.Provider value={openLink}>
        <MarkdownItem item={item} />
      </LinkOpenerContext.Provider>
    );
  if (item.type === 'code')
    return (
      <ScrollView horizontal style={styles.codeBlock} contentContainerStyle={styles.codeContent}>
        <Text selectable style={styles.code}>
          {item.content}
        </Text>
      </ScrollView>
    );
  if (item.type === 'table')
    return (
      <ScrollView horizontal style={styles.table}>
        <View>
          {[item.header, ...item.rows].map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={[styles.tableRow, rowIndex === 0 ? styles.tableHead : null]}
            >
              {row.map((cell, cellIndex) => (
                <Text
                  key={cellIndex}
                  selectable
                  style={[styles.cell, rowIndex === 0 ? styles.bold : null]}
                >
                  <Inline text={cell} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    );
  const line = item.content;
  if (line.trim() === '') return <View style={styles.gap} />;
  if (RULE.test(line)) return <View style={styles.rule} />;
  const heading = HEADING.exec(line);
  if (heading)
    return (
      <Text
        selectable
        accessibilityRole="header"
        style={heading[1]!.length <= 2 ? styles.headingLarge : styles.heading}
      >
        <Inline text={heading[2] ?? ''} />
      </Text>
    );
  const bullet = BULLET.exec(line);
  const ordered = bullet ? null : ORDERED.exec(line);
  if (bullet || ordered) {
    const indent = (bullet?.[1] ?? ordered?.[1] ?? '').length;
    return (
      <View style={[styles.listRow, { paddingLeft: Math.min(indent, 8) * 6 }]}>
        <Text style={styles.marker}>{bullet ? '•' : `${ordered![2]}.`}</Text>
        <Text selectable style={styles.listText}>
          <Inline text={(bullet ? bullet[2] : ordered![3]) ?? ''} />
        </Text>
      </View>
    );
  }
  const quote = QUOTE.exec(line);
  if (quote)
    return (
      <View style={styles.quote}>
        <Text selectable style={styles.quoteText}>
          <Inline text={quote[1] ?? ''} />
        </Text>
      </View>
    );
  return (
    <Text selectable style={styles.body}>
      <Inline text={line} />
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { ...theme.typography.body, color: theme.colors.text },
  bold: { fontFamily: theme.fonts.bold },
  inlineCode: {
    ...theme.typography.code,
    color: theme.colors.signature,
  },
  link: { color: theme.colors.action, textDecorationLine: 'underline' },
  wikiLink: { color: theme.colors.action },
  reference: { color: theme.colors.signature },
  headingLarge: {
    ...theme.typography.title,
    color: theme.colors.text,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  heading: {
    ...theme.typography.row,
    color: theme.colors.text,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xxs,
  },
  listRow: { flexDirection: 'row', gap: theme.spacing.sm },
  marker: { ...theme.typography.body, color: theme.colors.textMuted, minWidth: 14 },
  listText: { ...theme.typography.body, color: theme.colors.text, flex: 1 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing.md,
  },
  quoteText: { ...theme.typography.body, color: theme.colors.textMuted },
  rule: { height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing.md },
  gap: { height: theme.spacing.sm },
  codeBlock: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.control,
    marginVertical: theme.spacing.xs,
  },
  codeContent: { padding: theme.spacing.md },
  code: { ...theme.typography.code, color: theme.colors.text },
  table: { marginVertical: theme.spacing.xs },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  tableHead: { backgroundColor: theme.colors.surfaceAlt },
  cell: {
    ...theme.typography.bodySmall,
    color: theme.colors.text,
    width: 160,
    padding: theme.spacing.sm,
  },
}));
