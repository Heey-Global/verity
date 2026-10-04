import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { settingsStyles as styles } from './settings/settingsStyles';

/** Discovery is local to this device; hiding a hint never changes permissions. */
export function ConnectionDiscoveryHint({ id, onConnect }: { id: string; onConnect: () => void }) {
  const key = `verity.connection-hint.${id}`;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    setVisible(false);
    void AsyncStorage.getItem(key)
      .then((dismissed) => {
        if (active) setVisible(dismissed !== 'hidden');
      })
      .catch(() => {
        if (active) setVisible(true);
      });
    return () => {
      active = false;
    };
  }, [key]);
  if (!visible) return null;
  return (
    <View style={styles.panelStack}>
      <Text style={styles.reproSubtitle}>
        Keep your documents in Google Drive and use them in this project.
      </Text>
      <Pressable onPress={onConnect} accessibilityRole="link">
        <Text style={styles.reproHint}>Connect a folder</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          setVisible(false);
          void AsyncStorage.setItem(key, 'hidden').catch(() => undefined);
        }}
        accessibilityRole="button"
        accessibilityLabel="Hide Google Drive suggestion"
      >
        <Text style={styles.reproHint}>Hide suggestion</Text>
      </Pressable>
    </View>
  );
}
