import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from './Text';

/** Preserve diagnostic lines without letting long paths widen their surrounding card. */
export function CodeBlock({ text }: { text: string }) {
  return (
    <View>
      <Text variant="footnote">Scroll sideways for long lines.</Text>
      <ScrollView horizontal style={styles.viewport} accessibilityLabel="Technical output">
        <Text variant="code" selectable>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create(() => ({ viewport: { maxWidth: '100%', flexShrink: 1 } }));
