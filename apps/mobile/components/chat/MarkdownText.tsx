import type { AppLinkTarget, SessionFileRoot } from '@verity/mobile';
import {
  isSessionImageFilePath,
  markdownSectionTitle,
  parseAppLink,
  parseInline,
  parseMarkdownBlocks,
  sessionFilePathFromLocalLink,
  sessionFileTargetFromLocalLink,
  splitSearchHighlights,
} from '@verity/mobile';
import type { ImageSource } from 'expo-image';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { usePinnedImageSource } from '../../hooks/useAttachmentImageSource';
import { beginRenderWork } from '../../lib/sessionSwitchTiming';
import { TranscriptTimingContext } from '../TranscriptRow';
import { Image as ExpoImage } from '../ui/Image';
import { tint } from '../ui/tint';

/**
 * The Markdown of an agent's reply as the session chat renders it: headings,
 * lists, tables, inline bold, code and links. Shared by the session transcript
 * and Verity's panel, so a reply reads the same wherever it appears.
 */

export type OpenLocalFile = (path: string, root?: SessionFileRoot) => void;
// An agent's `verity://` link resolved by `parseAppLink`. The screen owns the
// navigation and the sheets, so it answers with the handler for a target, or null
// when the target cannot be opened here; the renderer then shows the same
// non-tappable reference styling as an unknown target instead of a link that
// would do nothing.
export type OpenAppLink = (target: AppLinkTarget) => (() => void) | null;
/** The search term highlighted in the transcript row it was found in. */
export const SearchHighlightContext = createContext<string | null>(null);

export function HighlightedSearchText({ text }: { text: string }) {
  const query = useContext(SearchHighlightContext);
  return splitSearchHighlights(text, query).map((segment, index) => (
    <Text key={index} style={segment.highlighted ? styles.searchTermHighlight : undefined}>
      {segment.text}
    </Text>
  ));
}

export function MarkdownText({
  content,
  onOpenLocalFile,
  onOpenAppLink,
  sessionFileImageSource,
  onOpenImage,
}: {
  content: string;
  onOpenLocalFile: OpenLocalFile | null;
  onOpenAppLink: OpenAppLink | null;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const finishMarkdownWork = beginRenderWork(
    'markdown-body',
    useContext(TranscriptTimingContext) ?? '',
  );
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  const rendered = (
    <View>
      {blocks.map((block, i) =>
        block.type === 'table' ? (
          <MarkdownTable key={i} header={block.header} rows={block.rows} />
        ) : (
          block.lines.map((line, j) => (
            <MarkdownLine
              key={`${i}-${j}`}
              line={line}
              onOpenLocalFile={onOpenLocalFile}
              onOpenAppLink={onOpenAppLink}
              sessionFileImageSource={sessionFileImageSource}
              onOpenImage={onOpenImage}
            />
          ))
        ),
      )}
    </View>
  );
  finishMarkdownWork();
  return rendered;
}

// A markdown table (GitHub-flavored: a header row, a `|---|` separator, body
// rows) → an aligned grid. The block-level parsing (`parseMarkdownBlocks` /
// `splitTableCells`) lives in @verity/mobile and is unit-tested; this component
// renders the parsed header + rows.
export function MarkdownTable({ header, rows }: { header: string[]; rows: string[][] }) {
  return (
    <View style={styles.table}>
      <View style={[styles.tableRow, styles.tableHeaderRow]}>
        {header.map((cell, i) => (
          <View key={i} style={styles.tableCell}>
            <SelectableMarkdownText textStyle={[styles.agentText, styles.tableHeaderText]}>
              <Inline text={cell} onOpenLocalFile={null} onOpenAppLink={null} />
            </SelectableMarkdownText>
          </View>
        ))}
      </View>
      {rows.map((row, ri) => (
        <View
          key={ri}
          style={[styles.tableRow, ri === rows.length - 1 ? styles.tableRowLast : null]}
        >
          {row.map((cell, ci) => (
            <View key={ci} style={styles.tableCell}>
              <SelectableMarkdownText textStyle={styles.agentText}>
                <Inline text={cell} onOpenLocalFile={null} onOpenAppLink={null} />
              </SelectableMarkdownText>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*(\d+)\.\s+(.*)$/;

// Agent prose uses native RN <Text>, not react-native-uitextview. Keep it out of
// generic flex rows: on iOS, selectable Text in a row can measure as one wide
// line and clip at the right edge. Direct column layout wraps normally and also
// avoids UITextView's clipped-height mis-measure.
function SelectableMarkdownText({
  textStyle,
  children,
}: {
  textStyle: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  return (
    <Text style={[styles.mdText, textStyle]} selectable>
      {children}
    </Text>
  );
}

export function MarkdownLine({
  line,
  onOpenLocalFile,
  onOpenAppLink,
  sessionFileImageSource,
  onOpenImage,
}: {
  line: string;
  onOpenLocalFile: OpenLocalFile | null;
  onOpenAppLink: OpenAppLink | null;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const imageLinks = useMemo(() => localImageLinks(line), [line]);
  const heading = HEADING.exec(line);
  if (heading) {
    return (
      <SelectableMarkdownText textStyle={[styles.agentText, styles.mdHeading]}>
        <Inline
          text={heading[2] ?? ''}
          onOpenLocalFile={onOpenLocalFile}
          onOpenAppLink={onOpenAppLink}
        />
      </SelectableMarkdownText>
    );
  }
  const bullet = BULLET.exec(line);
  if (bullet) {
    return (
      <View style={styles.mdListRow}>
        <Text style={styles.mdBullet}>•</Text>
        <View style={styles.mdTextSlot}>
          <SelectableMarkdownText textStyle={styles.agentText}>
            <Inline
              text={bullet[1] ?? ''}
              onOpenLocalFile={onOpenLocalFile}
              onOpenAppLink={onOpenAppLink}
            />
          </SelectableMarkdownText>
          <LocalImageLinks
            links={imageLinks}
            sessionFileImageSource={sessionFileImageSource}
            onOpenImage={onOpenImage}
          />
        </View>
      </View>
    );
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return (
      <View style={styles.mdListRow}>
        <Text style={styles.mdBullet}>{ordered[1]}.</Text>
        <View style={styles.mdTextSlot}>
          <SelectableMarkdownText textStyle={styles.agentText}>
            <Inline
              text={ordered[2] ?? ''}
              onOpenLocalFile={onOpenLocalFile}
              onOpenAppLink={onOpenAppLink}
            />
          </SelectableMarkdownText>
          <LocalImageLinks
            links={imageLinks}
            sessionFileImageSource={sessionFileImageSource}
            onOpenImage={onOpenImage}
          />
        </View>
      </View>
    );
  }
  const section = markdownSectionTitle(line);
  if (section) {
    return (
      <SelectableMarkdownText textStyle={[styles.agentText, styles.mdSectionHeading]}>
        <HighlightedSearchText text={section} />
      </SelectableMarkdownText>
    );
  }
  if (line.trim() === '') return <View style={styles.mdGap} />;
  return (
    <View>
      <SelectableMarkdownText textStyle={styles.agentText}>
        <Inline text={line} onOpenLocalFile={onOpenLocalFile} onOpenAppLink={onOpenAppLink} />
      </SelectableMarkdownText>
      <LocalImageLinks
        links={imageLinks}
        sessionFileImageSource={sessionFileImageSource}
        onOpenImage={onOpenImage}
      />
    </View>
  );
}

function localImageLinks(line: string): Array<{ path: string; label: string }> {
  const seen = new Set<string>();
  const links: Array<{ path: string; label: string }> = [];
  for (const span of parseInline(line)) {
    if (span.t !== 'link' || span.external) continue;
    const path = sessionFilePathFromLocalLink(span.url);
    if (path === null || !isSessionImageFilePath(path) || seen.has(path)) continue;
    seen.add(path);
    links.push({ path, label: span.text });
  }
  return links;
}

function LocalImageLinks({
  links,
  sessionFileImageSource,
  onOpenImage,
}: {
  links: Array<{ path: string; label: string }>;
  sessionFileImageSource: ((path: string) => ImageSource | undefined) | null;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  if (links.length === 0 || sessionFileImageSource === null) return null;
  return (
    <View style={styles.localLinkImages}>
      {links.map((link) => (
        <LocalImageLink
          key={link.path}
          link={link}
          sessionFileImageSource={sessionFileImageSource}
          onOpenImage={onOpenImage}
        />
      ))}
    </View>
  );
}

// A session-file image goes through the pinned downloader like a tool image: a
// direct HTTPS URL would reach expo-image, which rejects the self-signed
// certificate of a TLS-pinned endpoint and leaves an empty frame behind.
function LocalImageLink({
  link,
  sessionFileImageSource,
  onOpenImage,
}: {
  link: { path: string; label: string };
  sessionFileImageSource: (path: string) => ImageSource | undefined;
  onOpenImage: (source: ImageSource, label: string) => void;
}) {
  const immediate = useMemo(
    () => sessionFileImageSource(link.path),
    [sessionFileImageSource, link.path],
  );
  const source = usePinnedImageSource(immediate, `session-file-${link.path}`);
  if (source === undefined) return null;
  return (
    <Pressable
      onPress={() => onOpenImage(source, link.label)}
      accessibilityRole="imagebutton"
      accessibilityLabel={`View ${link.label} full screen`}
    >
      <ExpoImage
        source={source}
        style={styles.localLinkImage}
        contentFit="contain"
        transition={120}
      />
    </Pressable>
  );
}

// Render inline **bold** / `code` / link spans (nested Text lays them out inline).
// A link tap opens the URL in the system browser, a `verity://` link opens the
// whitelisted screen or sheet in the app; selection still works via a long-press
// on the surrounding selectable Text.
function Inline({
  text,
  onOpenLocalFile,
  onOpenAppLink,
}: {
  text: string;
  onOpenLocalFile: OpenLocalFile | null;
  onOpenAppLink: OpenAppLink | null;
}) {
  const { theme } = useUnistyles();
  return (
    <>
      {parseInline(text).map((span, i) => {
        if (span.t === 'bold') {
          return (
            <Text key={i} style={styles.mdBold}>
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        if (span.t === 'code') {
          return (
            <Text key={i} style={[styles.mdCode, { color: theme.colors.signature }]}>
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        if (span.t === 'link') {
          const appLink = span.external ? null : parseAppLink(span.url);
          const openApp =
            appLink !== null && onOpenAppLink !== null ? onOpenAppLink(appLink) : null;
          const local =
            span.external || appLink !== null ? null : sessionFileTargetFromLocalLink(span.url);
          const canOpenLocal = local !== null && onOpenLocalFile !== null;
          const asLink = span.external || openApp !== null;
          return (
            <Text
              key={i}
              style={[
                asLink ? styles.mdLink : styles.mdReference,
                { color: asLink ? theme.colors.action : theme.colors.signature },
              ]}
              // openURL rejects only if no handler can open it (no browser); swallow
              // so it never surfaces as an unhandled rejection (only http(s) reach here).
              onPress={
                span.external
                  ? () => void Linking.openURL(span.url).catch(() => undefined)
                  : openApp !== null
                    ? openApp
                    : canOpenLocal
                      ? () => onOpenLocalFile(local.path, local.root)
                      : undefined
              }
              accessibilityRole={asLink || canOpenLocal ? 'link' : undefined}
            >
              <HighlightedSearchText text={span.text} />
            </Text>
          );
        }
        return (
          <Text key={i}>
            <HighlightedSearchText text={span.text} />
          </Text>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentText: {
    color: theme.colors.text,
    fontSize: theme.typography.row.fontSize,
    lineHeight: 22 * theme.fontScale,
    fontFamily: theme.fonts.regular,
  },
  mdHeading: {
    fontSize: theme.typography.title.fontSize,
    fontFamily: theme.fonts.bold,
    marginTop: theme.spacing.xs,
  },
  mdSectionHeading: {
    fontFamily: theme.fonts.bold,
    marginTop: theme.spacing.sm,
  },
  mdListRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingLeft: theme.spacing.xs,
  },
  mdBullet: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.row.fontSize,
    lineHeight: 22 * theme.fontScale,
  },
  // Native selectable Text wraps reliably in normal column flow. Inside list
  // rows, give it an explicit flex slot so it can shrink before wrapping instead
  // of measuring as one clipped line on iOS.
  mdText: {
    width: '100%',
    flexShrink: 1,
  },
  mdTextSlot: {
    flex: 1,
    minWidth: 0,
  },
  mdGap: {
    height: theme.spacing.sm,
  },
  mdBold: {
    fontFamily: theme.fonts.bold,
  },
  mdCode: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.typography.bodySmall.fontSize,
  },
  mdLink: {
    textDecorationLine: 'underline',
  },
  mdReference: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: theme.typography.bodySmall.fontSize,
  },
  table: {
    marginVertical: theme.spacing.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableHeaderRow: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  tableCell: {
    flex: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  tableHeaderText: {
    fontFamily: theme.fonts.bold,
    color: theme.colors.text,
  },
  localLinkImages: {
    gap: theme.spacing.xs,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  localLinkImage: {
    width: '100%',
    height: 220,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  searchTermHighlight: {
    color: theme.colors.text,
    backgroundColor: tint(theme.colors.signature, 'border'),
    borderRadius: 3,
  },
}));
