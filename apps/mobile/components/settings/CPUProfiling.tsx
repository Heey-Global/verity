import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { CardRow } from '../premium/PremiumChrome';
import {
  cpuProfilingStatus,
  shareCPUProfile,
  startCPUProfiling,
  stopCPUProfiling,
} from '../../lib/cpuProfiling';

export function CPUProfiling() {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof cpuProfilingStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void cpuProfilingStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  const recording = status?.capture?.recording === true;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh, recording]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert('CPU profiling', error instanceof Error ? error.message : 'Recording failed.');
    } finally {
      setBusy(false);
      refresh();
    }
  };
  if (!status?.supported) return null;
  return (
    <>
      <CardRow
        title={recording ? 'Stop CPU recording' : 'Record CPU activity'}
        subtitle={
          status.capture?.error ||
          (recording
            ? 'Recording. Switch sessions now; stops after 30 seconds or when backgrounded.'
            : 'Records function names and app activity for up to 30 seconds. Export stays on your device until you share it.')
        }
        disabled={busy}
        onPress={() => void run(recording ? stopCPUProfiling : startCPUProfiling)}
      />
      <CardRow
        title="Export CPU capture"
        subtitle={
          status.capture?.ready
            ? `Recording stopped: ${status.capture.reason}`
            : 'Record and stop CPU activity first.'
        }
        disabled={busy || !status.capture?.ready}
        onPress={() => void run(shareCPUProfile)}
      />
    </>
  );
}
