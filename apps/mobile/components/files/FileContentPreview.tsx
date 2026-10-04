import { chunkFilePreview } from '@verity/mobile';
import { useMemo, useState, type ReactNode } from 'react';
import { FlatList, Text, View, type StyleProp, type ViewStyle, type TextStyle } from 'react-native';
import {
  fileMarkdownItems,
  isMarkdownFile,
  type FileMarkdownItem,
} from '../../lib/fileMarkdownPreview';
import { FileToolbarButton } from './FileToolbarButton';

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
        <View style={{ flexDirection: 'row', gap: 8, paddingVertical: 8 }}>
          <FileToolbarButton
            label="Preview"
            selected={!source}
            tone={!source ? 'primary' : 'plain'}
            onPress={() => setSource(false)}
          />
          <FileToolbarButton
            label="Source"
            selected={source}
            tone={source ? 'primary' : 'plain'}
            onPress={() => setSource(true)}
          />
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
