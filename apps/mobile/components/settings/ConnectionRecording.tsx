import type { ConnectionRecordingExport, VerityClient } from '@verity/mobile';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { CardRow, Eyebrow, RowCard } from '../premium/PremiumChrome';
import { getServerProfile } from '../../lib/serverProfile';
import {
  exportRemoteDataDiagnostics,
  validateStoredRemoteRecording,
  selectRemoteRecording,
} from '../../lib/remoteDataDiagnostics';
import {
  remoteDataRecordingRemainingMs,
  startRemoteDataRecording,
  stopRemoteDataRecording,
} from '../../lib/remoteControlTransport';

type SavedRun = {
  runId: string;
  expiresAt: number;
  startedAt: number;
  local: string | null;
  diagnosticsVersion?: 1 | 2;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function parseSaved(raw: string | null): SavedRun | null {
  if (!raw || raw.length > 600_000) return null;
  try {
    const value = JSON.parse(raw) as SavedRun;
    if (
      !UUID.test(value.runId) ||
      (value.diagnosticsVersion !== undefined &&
        value.diagnosticsVersion !== 1 &&
        value.diagnosticsVersion !== 2) ||
      !Number.isFinite(value.expiresAt) ||
      !Number.isFinite(value.startedAt) ||
      value.startedAt < 0 ||
      value.startedAt > 8e12 ||
      value.expiresAt < value.startedAt ||
      value.expiresAt > 8e12 ||
      !(value.local === null || typeof value.local === 'string')
    )
      return null;
    return {
      runId: value.runId,
      expiresAt: value.expiresAt,
      startedAt: value.startedAt,
      diagnosticsVersion: value.diagnosticsVersion ?? 1,
      local: value.local === null ? null : validateStoredRemoteRecording(value.local),
    };
  } catch {
    return null;
  }
}

/** Coordinates preparation over VPN; the local Stop never depends on that path. */
export function ConnectionRecording({ client }: { client: VerityClient | null }) {
  const serverId = getServerProfile()?.serverId;
  const key = serverId ? `verity.connectionRecording.v1.${serverId}` : null;
  const runRef = useRef<SavedRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const collectingRef = useRef<number | null>(null);
  const preparingRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [message, setMessage] = useState(
    'Connect through VPN to prepare App, Core and Uplink together for up to 2 minutes.',
  );
  const revision = useRef(0);
  const mounted = useRef(true);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const save = (value: SavedRun) => {
    runRef.current = value;
    const write = saving.current
      .catch(() => undefined)
      .then(async () => {
        if (!key) throw new Error('No paired server');
        await AsyncStorage.setItem(key, JSON.stringify(value));
      });
    saving.current = write;
    return write;
  };
  useEffect(() => {
    mounted.current = true;
    let current = true;
    setLoaded(false);
    setReady(false);
    setPreparing(false);
    setCollecting(false);
    setRemaining(0);
    preparingRef.current = null;
    collectingRef.current = null;
    runRef.current = null;
    setMessage('Connect through VPN to prepare App, Core and Uplink together for up to 2 minutes.');
    void (async () => {
      try {
        const saved = key ? parseSaved(await AsyncStorage.getItem(key)) : null;
        if (current) {
          runRef.current = saved;
          if (saved)
            setMessage('Saved run available. Stop and collect, or retry collection with VPN.');
        }
      } catch {
        if (current) setMessage('Could not read the saved run. Recording is unavailable.');
      } finally {
        if (current) setLoaded(true);
      }
    })();
    return () => {
      current = false;
      mounted.current = false;
      revision.current++;
    };
  }, [key]);
  useEffect(() => {
    let current = true;
    const poll = async () => {
      const token = revision.current;
      const left = await remoteDataRecordingRemainingMs();
      if (!current || token !== revision.current) return;
      setRemaining(left ?? 0);
      if (left === null || left <= 0) {
        setReady(false);
        setMessage((previous) =>
          previous.startsWith('Ready')
            ? 'Local recording ended. Stop and collect the saved evidence.'
            : previous,
        );
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);

  const start = async () => {
    if (!loaded || preparing || collectingRef.current || !key || !client) return;
    const token = ++revision.current;
    preparingRef.current = token;
    setPreparing(true);
    setReady(false);
    setMessage('Preparing local recording, Core and Uplink…');
    const saved: SavedRun = {
      runId: randomUUID(),
      startedAt: Date.now(),
      expiresAt: Date.now() + 120_000,
      local: null,
      diagnosticsVersion: 2,
    };
    runRef.current = saved;
    let requested = false;
    try {
      await save(saved);
      if (token !== revision.current) return;
      const duration = await startRemoteDataRecording();
      if (token !== revision.current) return;
      saved.expiresAt = Date.now() + duration;
      await save(saved);
      if (token !== revision.current) return;
      const remainingDuration = Math.floor(saved.expiresAt - Date.now());
      if (remainingDuration <= 0) throw new Error('Recording expired');
      requested = true;
      const status = await client.startConnectionRecording(
        saved.runId,
        Math.min(120_000, remainingDuration),
        2,
      );
      if (token !== revision.current) {
        await client.stopConnectionRecording(saved.runId).catch(() => undefined);
        return;
      }
      if (status.error === 'uplink_version_unavailable')
        throw new Error('diagnostics_version_unavailable');
      const left = await remoteDataRecordingRemainingMs();
      if (token !== revision.current) return;
      if (
        status.runId !== saved.runId ||
        status.phase !== 'recording' ||
        status.core.state !== 'recording' ||
        status.uplink.state !== 'recording' ||
        status.error !== null ||
        !left ||
        Date.parse(status.expiresAt) <= Date.now()
      )
        throw new Error('Not ready');
      setRemaining(left);
      setReady(true);
      setMessage('Ready — turn off VPN and use the app normally. Stop and collect when finished.');
    } catch (error) {
      if (token !== revision.current) return;
      const localStopped = await stopRemoteDataRecording();
      const remoteStopped =
        !requested ||
        (await client.stopConnectionRecording(saved.runId).then(
          (value) =>
            value.runId === saved.runId &&
            value.core.state === 'stopped' &&
            value.uplink.state === 'stopped',
          () => false,
        ));
      if (mounted.current && token === revision.current)
        setMessage(
          `${error instanceof Error && error.message === 'diagnostics_version_unavailable' ? 'Uplink does not support this recording version. Update Uplink before retrying.' : 'Preparation failed.'} ${localStopped ? 'Local recording stopped.' : 'Local stop could not be confirmed.'} ${remoteStopped ? 'Keep VPN on and retry.' : 'Core/Uplink stop unconfirmed; they expire automatically. Retry collection with VPN.'}`,
        );
    } finally {
      if (mounted.current && preparingRef.current === token) {
        preparingRef.current = null;
        setPreparing(false);
      }
    }
  };

  const collect = async () => {
    // Duplicate taps still stop locally, but never create competing exports.
    if (collectingRef.current !== null) {
      await stopRemoteDataRecording();
      return;
    }
    const token = ++revision.current;
    collectingRef.current = token;
    setCollecting(true);
    setReady(false);
    const current = () => mounted.current && revision.current === token;
    const saved = runRef.current;
    try {
      // No Core request, storage operation or pending start can delay local Stop.
      const localStopped = await stopRemoteDataRecording();
      if (!current()) return;
      setRemaining(0);
      setMessage(
        localStopped
          ? 'Local recording stopped. Collecting Core and Uplink…'
          : 'Local stop unconfirmed. Collecting available evidence…',
      );
      if (!saved) {
        setMessage(
          localStopped
            ? 'Local recording stopped. No coordinated run saved.'
            : 'Local stop could not be confirmed.',
        );
        return;
      }
      const local = await exportRemoteDataDiagnostics();
      if (!current()) return;
      const updated = {
        ...saved,
        local:
          local.status === 'ready'
            ? (selectRemoteRecording(local.recording, saved.startedAt, saved.expiresAt) ??
              saved.local)
            : saved.local,
      };
      let persisted = true;
      try {
        await save(updated);
      } catch {
        persisted = false;
      }
      if (!current()) return;
      let remote: ConnectionRecordingExport | null = null;
      let remoteStopped = false;
      try {
        if (!client) throw new Error('Core unavailable');
        const status = await client.stopConnectionRecording(saved.runId);
        if (!current()) return;
        remoteStopped =
          status.runId === saved.runId &&
          status.core.state === 'stopped' &&
          status.uplink.state === 'stopped';
        const result = await client.exportConnectionRecording(
          saved.runId,
          saved.diagnosticsVersion ?? 1,
        );
        if (!current()) return;
        if (result.status.runId === saved.runId) remote = result;
      } catch {
        /* Local evidence remains available while the tunnel is unavailable. */
      }
      if (!current()) return;
      const bundle = {
        version: 1,
        runId: saved.runId,
        startedAt: new Date(saved.startedAt).toISOString(),
        app: {
          available: updated.local !== null,
          stopped: localStopped,
          recording: updated.local ? (JSON.parse(updated.local) as unknown) : null,
        },
        remote: { available: remote !== null, stopped: remoteStopped, recording: remote },
      };
      await Clipboard.setStringAsync(JSON.stringify(bundle));
      if (!current()) return;
      setMessage(
        remote && remote.uplink.available && updated.local && localStopped && remoteStopped
          ? 'App, Core and Uplink recording copied.'
          : `Partial recording copied. ${!updated.local ? 'App recording missing. ' : ''}${!remote ? 'Core/Uplink export unavailable. ' : !remote.uplink.available ? 'Uplink export missing. ' : ''}${!localStopped ? 'Local stop unconfirmed. ' : ''}${!remoteStopped ? 'Core/Uplink stop unconfirmed. ' : ''}Turn VPN on and tap Stop and collect again. ${!persisted ? 'Saving locally failed; keep this screen open.' : ''}`,
      );
    } catch {
      if (current()) setMessage('Could not copy the recording. Retry Stop and collect.');
    } finally {
      if (collectingRef.current === token) {
        collectingRef.current = null;
        if (mounted.current) setCollecting(false);
      }
    }
  };

  return (
    <View>
      <Eyebrow>Connection recording</Eyebrow>
      <RowCard>
        <CardRow
          title="Record connection"
          subtitle={message}
          disabled={!loaded || preparing || collecting || !key || !client || remaining > 0}
          onPress={() => void start()}
        />
        <CardRow
          title="Stop and collect"
          subtitle="Stops this device immediately. Turn VPN back on to collect Core and Uplink; otherwise a partial report is copied."
          onPress={() => void collect()}
        />
        {ready ? (
          <CardRow
            title={`${String(Math.ceil(remaining / 1000))} seconds remaining`}
            chevron={false}
          />
        ) : null}
      </RowCard>
    </View>
  );
}
