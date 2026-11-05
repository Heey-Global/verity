import { useEffect, useState } from 'react';
import { Alert, AppState, Share } from 'react-native';
import {
  SettingsGroup,
  SettingsListPanel,
  SettingsNavRow,
  SettingsPanel,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { saveTaskPreferences, useTaskPreferences } from '../../lib/taskPreferences';
import {
  discardWaitingWatchCaptures,
  showWatchSettings,
  watchBridgeAvailable,
  watchInboxLog,
  watchStatus,
  type WatchStatus,
} from '../../lib/watchCapture';

function watchLabel(status: WatchStatus): string {
  if (!status.supported) return 'Unavailable on this device';
  if (!status.paired) return 'No watch paired';
  if (!status.watchAppInstalled) return 'Verity not installed on the watch';
  return status.reachable ? 'Connected' : 'Installed, not reachable now';
}

async function shareWatchLog(): Promise<void> {
  const lines = await watchInboxLog();
  await Share.share({ message: lines.length ? lines.join('\n') : 'No watch captures yet.' });
}

function save(patch: Parameters<typeof saveTaskPreferences>[0]): void {
  void saveTaskPreferences(patch).catch((error: unknown) =>
    Alert.alert('Could not save preference', error instanceof Error ? error.message : 'Try again'),
  );
}

export default function TasksSettingsScreen() {
  const preferences = useTaskPreferences();
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  useEffect(() => {
    let active = true;
    // Pairing is only known once the session has activated; right after launch
    // that can lag behind this screen, so look once more before hiding the section.
    const loadWatch = (retry: boolean) =>
      void watchStatus()
        .then((next) => {
          if (!active) return;
          setWatch(next);
          if (retry && next.supported && !next.activated) setTimeout(() => loadWatch(false), 1000);
        })
        .catch(() => undefined);
    const refresh = () => {
      if (watchBridgeAvailable) loadWatch(true);
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return (
    <SettingsScaffold title="Tasks" detail>
      <SettingsGroup
        title="Verity button"
        description="The V at the screen edge. Tap it to talk to Verity, hold it to type."
      >
        <SettingsPanel>
          <SettingsToggleRow
            label="Show Verity button"
            value={preferences.enabled}
            onValueChange={(value) => save({ enabled: value })}
          />
        </SettingsPanel>
      </SettingsGroup>
      {showWatchSettings(watch) ? (
        <SettingsGroup
          title="Apple Watch"
          description="Record on the watch; your iPhone transcribes the audio and saves it as a task. Prototype."
        >
          <SettingsListPanel>
            <SettingsNavRow
              icon="watch"
              title="Watch app"
              value={watchLabel(watch)}
              onPress={() =>
                void watchStatus()
                  .then(setWatch)
                  .catch(() => undefined)
              }
              accessibilityLabel={`Watch app, ${watchLabel(watch)}`}
            />
            {watch.waiting ? (
              <SettingsNavRow
                icon="inbox"
                title="Waiting captures"
                subtitle="Transcribed, not saved yet: sign in to the account and keep the project they were recorded for, or tap to discard"
                value={String(watch.waiting)}
                onPress={() =>
                  Alert.alert(
                    'Discard waiting captures?',
                    'Their text is only kept here and cannot be recovered.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Discard',
                        style: 'destructive',
                        onPress: () =>
                          void discardWaitingWatchCaptures()
                            .then(watchStatus)
                            .then(setWatch)
                            .catch(() => undefined),
                      },
                    ],
                  )
                }
                accessibilityLabel={`${String(watch.waiting)} watch captures waiting`}
              />
            ) : null}
            <SettingsNavRow
              icon="share"
              title="Share watch log"
              subtitle="Receive and transcription timings"
              onPress={() =>
                void shareWatchLog().catch((error: unknown) =>
                  Alert.alert(
                    'Could not share log',
                    error instanceof Error ? error.message : 'Try again',
                  ),
                )
              }
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
      <SettingsGroup title="Position">
        <SettingsListPanel>
          <SettingsNavRow
            icon="corner-down-right"
            title="Reset button position"
            subtitle="Puts the V back on the right edge"
            onPress={() => save({ side: 'right', fraction: 0.65 })}
          />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
