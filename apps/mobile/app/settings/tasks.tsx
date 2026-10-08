import { useEffect, useState } from 'react';
import { Alert, AppState, Linking, Share } from 'react-native';
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
  enableTaskScreenshotSuggestions,
  screenshotAccess,
  type ScreenshotAccess,
} from '../../lib/taskScreenshot';
import {
  watchBridgeAvailable,
  watchInboxLog,
  watchStatus,
  type WatchStatus,
} from '../../lib/watchCapture';

const ACCESS_LABEL: Record<ScreenshotAccess, string> = {
  granted: 'Allowed',
  undetermined: 'Not asked yet',
  denied: 'Not allowed',
  unavailable: 'Unavailable on this device',
};

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
  const [access, setAccess] = useState<ScreenshotAccess | null>(null);
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void screenshotAccess().then((next) => {
        if (active) setAccess(next);
      });
      if (watchBridgeAvailable)
        void watchStatus()
          .then((next) => {
            if (active) setWatch(next);
          })
          .catch(() => undefined);
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
  const requestAccess = () => {
    if (access === 'denied') {
      void Linking.openSettings();
      return;
    }
    void enableTaskScreenshotSuggestions()
      .catch(() => undefined)
      .finally(() => void screenshotAccess().then(setAccess));
  };
  return (
    <SettingsScaffold title="Tasks" detail>
      <SettingsGroup
        title="Capture bubble"
        description="The mic at the screen edge. Tap it to record a task, hold it to see your list."
      >
        <SettingsPanel>
          <SettingsToggleRow
            label="Show capture bubble"
            value={preferences.enabled}
            onValueChange={(value) => save({ enabled: value })}
          />
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup
        title="Screenshots"
        description="Offers a screenshot taken in the last two minutes, so you can attach it in one tap. Needs access to your photos."
      >
        <SettingsPanel>
          <SettingsToggleRow
            label="Suggest recent screenshots"
            value={preferences.screenshots}
            onValueChange={(value) => {
              save({ screenshots: value, ...(value ? { screenshotPromptDismissed: false } : {}) });
              if (value && access === 'undetermined') requestAccess();
            }}
          />
        </SettingsPanel>
        {access !== null && access !== 'unavailable' ? (
          <SettingsListPanel>
            <SettingsNavRow
              icon="image"
              title="Photo access"
              value={ACCESS_LABEL[access]}
              status={
                access === 'granted'
                  ? { intent: 'ready', label: 'Allowed' }
                  : { intent: 'optional', label: ACCESS_LABEL[access] }
              }
              onPress={access === 'granted' ? () => void Linking.openSettings() : requestAccess}
              accessibilityLabel={`Photo access, ${ACCESS_LABEL[access]}`}
            />
          </SettingsListPanel>
        ) : null}
      </SettingsGroup>
      {watch ? (
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
                subtitle="Transcribed, not saved yet: sign in to the account and keep the project they were recorded for"
                value={String(watch.waiting)}
                onPress={() =>
                  void watchStatus()
                    .then(setWatch)
                    .catch(() => undefined)
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
            title="Reset bubble position"
            subtitle="Puts the bubble back on the right edge"
            onPress={() => save({ side: 'right', fraction: 0.65 })}
          />
        </SettingsListPanel>
      </SettingsGroup>
    </SettingsScaffold>
  );
}
