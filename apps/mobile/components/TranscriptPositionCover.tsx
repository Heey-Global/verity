import {
  ActivityIndicator,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Covers the transcript while it settles: while a jump to a message or bookmark
 * pages in history, and while a saved position is restored, so the reader never
 * sees the intermediate pages or the measurement correction.
 */
export function TranscriptPositionCover({
  restoring,
  finding,
  jumping,
  styles,
}: {
  restoring: boolean;
  /** Still loading earlier pages for a jump. */
  finding: boolean;
  /** Scrolling to the jump's target. */
  jumping: boolean;
  styles: { restoreCover: StyleProp<ViewStyle>; emptySubtitle: StyleProp<TextStyle> };
}) {
  const { theme } = useUnistyles();
  const jump = finding ? 'finding' : jumping ? 'jumping' : null;
  if (!restoring && jump === null) return null;
  return (
    <View style={styles.restoreCover}>
      <ActivityIndicator
        color={theme.colors.textMuted}
        accessibilityLabel={
          jump !== null ? 'Jumping to message or bookmark' : 'Restoring chat position'
        }
      />
      {jump !== null ? (
        <Text style={styles.emptySubtitle}>
          {jump === 'finding'
            ? 'Finding previous message or bookmark…'
            : 'Jumping to message or bookmark…'}
        </Text>
      ) : null}
    </View>
  );
}
