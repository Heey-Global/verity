import { parseInline, parseMarkdownBlocks, splitRichText } from '@verity/mobile';
import { Linking, Text, View } from 'react-native';
import { styles } from './styles';

function Inline({ text, onLink }: { text: string; onLink?: (url: string) => void }) {
  return (
    <>
      {parseInline(text).map((span, i) => (
        <Text
          key={i}
          style={span.t === 'bold' ? styles.bold : span.t === 'code' ? styles.code : undefined}
          onPress={
            span.t === 'link'
              ? () => {
                  if (/^https?:\/\//i.test(span.url)) {
                    void Linking.openURL(span.url);
                  } else {
                    onLink?.(span.url);
                  }
                }
              : undefined
          }
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

/** Native text rendering never interprets document HTML or executes scripts. */
export function KnowledgeMarkdown({
  body,
  onLink,
}: {
  body: string;
  onLink?: (url: string) => void;
}) {
  return (
    <View style={styles.group}>
      {splitRichText(body).map((block, i) =>
        block.type === 'code' ? (
          <Text key={i} selectable style={[styles.text, styles.code]}>
            {block.content}
          </Text>
        ) : (
          <View key={i}>
            {parseMarkdownBlocks(block.content).map((part, j) =>
              part.type === 'table' ? (
                <View key={j} style={styles.group}>
                  {[part.header, ...part.rows].map((row, k) => (
                    <View key={k} style={styles.row}>
                      {row.map((cell, n) => (
                        <Text key={n} style={[styles.text, styles.cell, k === 0 && styles.bold]}>
                          <Inline text={cell} onLink={onLink} />
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              ) : (
                <View key={j}>
                  {part.lines.map((line, n) => (
                    <Text
                      key={n}
                      selectable
                      style={[styles.text, /^#{1,6} /.test(line) && styles.heading]}
                    >
                      <Inline
                        onLink={onLink}
                        text={line.replace(/^#{1,6} /, '').replace(/^\s*[-*] /, '• ')}
                      />
                    </Text>
                  ))}
                </View>
              ),
            )}
          </View>
        ),
      )}
    </View>
  );
}
