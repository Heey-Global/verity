import { chunkFilePreview } from '@verity/mobile';
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  fileMarkdownItems,
  isMarkdownFile,
  type FileMarkdownItem,
} from '../../lib/fileMarkdownPreview';

/** Mount with a file-specific key so opening another file starts in Preview. */
export function FileContentPreview({
  path,
  content,
  renderMarkdown,
  listStyle,
  bodyStyle,
  textStyle,
  header,
  footer,
}: {
  path: string;
  content: string;
  renderMarkdown: (item: FileMarkdownItem) => ReactNode;
  listStyle?: StyleProp<ViewStyle>;
  bodyStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  /** Drawn in place of the page's own leading `# Title` in Preview. */
  header?: ReactElement | undefined;
  /** Drawn after the page in Preview. */
  footer?: ReactElement | undefined;
}) {
  const [source, setSource] = useState(false);
  const markdown = isMarkdownFile(path);
  const formatted = markdown && !source;
  // Whether there is a header, not which element: a new one each render must
  // not parse the whole file again.
  const withHeader = header !== undefined;
  const items = useMemo(() => {
    if (!formatted)
      return chunkFilePreview(content).map((content): FileMarkdownItem => ({
        type: 'line',
        content,
      }));
    const all = fileMarkdownItems(content);
    if (!withHeader) return all;
    // The header names the page; its own title line would say it twice.
    const first = all.findIndex((item) => item.type !== 'line' || item.content.trim() !== '');
    const title = all[first];
    return title?.type === 'line' && /^#\s/.test(title.content) ? all.slice(first + 1) : all;
  }, [content, formatted, withHeader]);
  return (
    <>
      {markdown ? (
        // The same underlined tabs as the explorer's roots: two views of one
        // file are a place to be, not an action to take.
        <View style={styles.modes} accessibilityRole="tablist">
          {(
            [
              ['Preview', false],
              ['Source', true],
            ] as const
          ).map(([label, value]) => (
            <Pressable
              key={label}
              onPress={() => setSource(value)}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: source === value }}
              style={[styles.mode, source === value ? styles.modeActive : null]}
            >
              <Text style={source === value ? styles.modeLabelActive : styles.modeLabel}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        key={formatted ? 'preview' : 'source'}
        style={listStyle}
        contentContainerStyle={bodyStyle}
        data={items}
        keyExtractor={(_, index) => String(index)}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        renderItem={({ item }) =>
          formatted ? (
            <>{renderMarkdown(item)}</>
          ) : (
            <Text selectable style={textStyle}>
              {'content' in item ? item.content : ''}
            </Text>
          )
        }
        // With a header the page has its title even when nothing follows it.
        ListEmptyComponent={
          content.trim() === '' && !withHeader ? <Text style={textStyle}>Empty file</Text> : null
        }
        ListHeaderComponent={formatted ? header : undefined}
        ListFooterComponent={formatted ? footer : undefined}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  modes: {
    flexDirection: 'row',
    gap: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  mode: {
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -StyleSheet.hairlineWidth,
  },
  modeActive: { borderBottomColor: theme.colors.action },
  modeLabel: {
    color: theme.colors.textMuted,
    fontFamily: theme.fonts.regular,
    fontSize: theme.typography.footnote.fontSize,
  },
  modeLabelActive: {
    color: theme.colors.text,
    fontSize: theme.typography.footnote.fontSize,
    fontFamily: theme.fonts.semibold,
  },
}));
