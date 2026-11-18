// A full-screen camera that reads one QR code. Server pairing and joining a
// shared project both scan a code shown on another screen.
import { CameraView } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Modal, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Button } from './Button';

/**
 * Shows the camera while `visible`. The camera reports a code many times a
 * second while it stays in view; `onScan` receives only the first one of each
 * opening, so a screen never starts the same work twice. Camera permission is
 * the caller's to request, since each screen explains its own refusal.
 */
export function QrScanner({
  visible,
  title,
  onScan,
  onClose,
}: {
  visible: boolean;
  title: string;
  onScan: (data: string) => void;
  onClose: () => void;
}) {
  const scanned = useRef(false);
  useEffect(() => {
    if (visible) scanned.current = false;
  }, [visible]);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (scanned.current) return;
            scanned.current = true;
            onScan(data);
          }}
        />
        <View style={styles.overlay} pointerEvents="box-none">
          <Text style={styles.title}>{title}</Text>
          <View style={styles.frame} />
          <Button label="Cancel" variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 80,
    paddingBottom: 56,
  },
  title: {
    ...theme.typography.row,
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.radius.md,
  },
  frame: {
    width: 260,
    height: 260,
    borderWidth: 3,
    borderColor: '#ffffff',
    borderRadius: theme.radius.lg,
  },
}));
