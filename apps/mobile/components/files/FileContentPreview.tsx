import { chunkFilePreview } from '@verity/mobile';
import { useMemo, useState, type ReactNode } from 'react';
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
}: {
  path: string;
  content: string;
  renderMarkdown: (item: FileMarkdownItem) => ReactNode;
  listStyle?: StyleProp<ViewStyle>;
  bodyStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  const [source, setSource] = useState(false);
  const markdown = isMarkdownFile(path);
  const formatted = markdown && !source;
  const items = useMemo(
    () =>
      formatted
        ? fileMarkdownItems(content)
        : chunkFilePreview(content).map((content): FileMarkdownItem => ({ type: 'line', content })),
    [content, formatted],
  );
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
        ListEmptyComponent={<Text style={textStyle}>Empty file</Text>}
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
  modeActive: { borderBottomColor: theme.colors.primary },
  modeLabel: { color: theme.colors.textMuted, fontSize: theme.text.xs },
  modeLabelActive: { color: theme.colors.text, fontSize: theme.text.xs, fontWeight: '600' },
}));
