import type { VerityClient } from '@verity/mobile';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useServerReleaseNotes } from '../../lib/serverReleaseNotes';
import { settingsStyles as styles } from './settingsStyles';

/** "What's new" for a pending Server update; renders nothing it cannot read. */
export function ServerReleaseNotes({ client, version }: { client: VerityClient; version: string }) {
  const { theme } = useUnistyles();
  const notes = useServerReleaseNotes(client, version);

  if (notes === undefined) {
    return (
      <View style={styles.releaseNotes}>
        <ActivityIndicator size="small" color={theme.colors.setup.textMuted} />
      </View>
    );
  }
  if (notes === null) return null;

  return (
    <View style={styles.releaseNotes}>
      <Text style={styles.releaseNotesTitle} accessibilityRole="header">
        What&apos;s new
      </Text>
      {notes.sections.map((section) => (
        <View key={section.title} style={styles.releaseNotesSection}>
          <Text style={styles.releaseNotesHeading}>{section.title}</Text>
          {section.items.map((item) => (
            <View key={item} style={styles.releaseNotesItem}>
              <Text style={styles.updateDetail}>•</Text>
              <Text style={[styles.updateDetail, styles.releaseNotesItemText]}>{item}</Text>
            </View>
          ))}
        </View>
      ))}
      <Pressable
        onPress={() => void Linking.openURL(notes.url).catch(() => undefined)}
        hitSlop={8}
        accessibilityRole="link"
        accessibilityLabel="Full release notes on GitHub"
      >
        <Text style={styles.linkText}>Full release notes on GitHub</Text>
      </Pressable>
    </View>
  );
}
