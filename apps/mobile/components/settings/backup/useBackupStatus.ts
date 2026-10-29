// The server's backup status for the backup screens: read on focus, and polled
// only while something on the server is moving (a capture or a restore test) or
// the caller asks to watch it.
import { VerityApiError, type BackupStatus, type VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { probeRunning } from './backupText';

const POLL_MS = 3000;

export type BackupStatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: BackupStatus }
  | { kind: 'error'; message: string };

export function useBackupStatus(
  client: VerityClient,
  { poll = false }: { poll?: boolean } = {},
): {
  state: BackupStatusState;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<BackupStatusState>({ kind: 'loading' });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    try {
      const status = await client.getBackupStatus();
      if (mounted.current) setState({ kind: 'ready', status });
    } catch (error) {
      if (!mounted.current) return;
      setState({
        kind: 'error',
        message:
          error instanceof VerityApiError && error.status === 403
            ? 'Only administrators can manage backups.'
            : 'Could not load the backup status.',
      });
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );
  const moving =
    poll ||
    (state.kind === 'ready' &&
      state.status.available &&
      (state.status.capturing === true || probeRunning(state.status.probe)));
  useEffect(() => {
    if (!moving) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [moving, reload]);
  return { state, reload };
}
