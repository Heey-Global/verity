import type { CalendarWatch, VerityClient } from '@verity/mobile';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  SettingsChoiceRow,
  SettingsGroup,
  SettingsListPanel,
  SettingsMessage,
  SettingsNavRow,
  SettingsScaffold,
  SettingsToggleRow,
} from '../../components/settings/SettingsChrome';
import { Row, Sheet } from '../../components/ui';
import { createVerityClient } from '../../lib/client';

const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90] as const;

const days = (count: number) => `${String(count)} ${count === 1 ? 'day' : 'days'}`;

/** Which Google calendars Verity watches for online meetings (docs/live-meeting-calendar.md).
 *  A calendar has no project: meetings joined from it are assigned afterwards. */
export default function MeetingCalendarsSettings() {
  const client = useMemo(() => createVerityClient(), []);
  return client ? (
    <MeetingCalendarsContent client={client} />
  ) : (
    <SettingsMessage title="Connect to your server first." screenTitle="Meeting calendars" />
  );
}

type Calendar = CalendarWatch['accounts'][number]['calendars'][number];

function MeetingCalendarsContent({ client }: { client: VerityClient }) {
  const [watch, setWatch] = useState<CalendarWatch>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [choosingRetention, setChoosingRetention] = useState(false);
  const loadId = useRef(0);
  // Loaded on focus and after each change only: every read asks Google for the calendar list.
  const load = useCallback(async () => {
    const id = ++loadId.current;
    try {
      const next = await client.getCalendarWatch();
      if (id !== loadId.current) return;
      setWatch(next);
      setError(undefined);
    } catch (reason) {
      if (id === loadId.current)
        setError(reason instanceof Error ? reason.message : 'Could not load calendars.');
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const save = async (
    change: () => Promise<unknown>,
    optimistic: (current: CalendarWatch) => CalendarWatch,
  ) => {
    if (saving || !watch) return;
    setSaving(true);
    setWatch(optimistic(watch));
    try {
      await change();
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the change.');
    } finally {
      setSaving(false);
      await load();
    }
  };
  const choose = (accountId: string, calendar: Calendar, watched: boolean, autoJoin: boolean) =>
    save(
      () =>
        client.setCalendarWatch({
          accountId,
          calendarId: calendar.id,
          watched,
          autoJoin: watched && autoJoin,
        }),
      (current) => ({
        ...current,
        accounts: current.accounts.map((account) =>
          account.id !== accountId
            ? account
            : {
                ...account,
                calendars: account.calendars.map((item) =>
                  item.id === calendar.id
                    ? { ...item, watched, autoJoin: watched && autoJoin }
                    : item,
                ),
              },
        ),
      }),
    );
  const setRetention = (count: number) => {
    setChoosingRetention(false);
    void save(
      () => client.updateVeritySettings({ unassignedMeetingRetentionDays: count }),
      (current) => ({ ...current, retentionDays: count }),
    );
  };

  return (
    <SettingsScaffold
      title="Meeting calendars"
      detail
      state={{ error, saving }}
      onRetry={() => void load()}
    >
      {watch?.accounts.length === 0 ? (
        <SettingsGroup title="Calendars">
          <SettingsListPanel>
            <Row title="No Google account" subtitle="Add one in Settings › Google first" />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
      {watch?.accounts.flatMap((account) => {
        if (account.access === 'missing_scope' && account.calendars.length === 0)
          return [
            <SettingsGroup key={account.id} title={account.displayName ?? account.email}>
              <SettingsListPanel>
                <Row
                  title="No Calendar access"
                  subtitle="Grant the missing permissions in Settings › Google"
                />
              </SettingsListPanel>
            </SettingsGroup>,
          ];
        return account.calendars.map((calendar) => (
          <SettingsGroup
            key={`${account.id}/${calendar.id}`}
            title={
              calendar.summary === account.email
                ? account.email
                : `${calendar.summary} · ${account.email}`
            }
            {...(account.access === 'unavailable'
              ? { description: 'Google could not be reached; showing what is watched.' }
              : {})}
          >
            <SettingsListPanel>
              <SettingsToggleRow
                label="Watch for meetings"
                subtitle="Ask 5 min before a meeting with a link"
                value={calendar.watched}
                disabled={saving}
                onValueChange={(value) => void choose(account.id, calendar, value, false)}
              />
              {calendar.watched ? (
                <SettingsToggleRow
                  label="Join automatically"
                  subtitle="Without asking first"
                  value={calendar.autoJoin}
                  disabled={saving}
                  onValueChange={(value) => void choose(account.id, calendar, true, value)}
                />
              ) : null}
            </SettingsListPanel>
          </SettingsGroup>
        ));
      })}
      {watch ? (
        <SettingsGroup
          title="Unassigned meetings"
          description="Meetings without a project are deleted after this period. Only accepted events with a Meet, Teams or Zoom link are considered."
        >
          <SettingsListPanel>
            <SettingsNavRow
              icon="clock"
              title="Keep for"
              value={days(watch.retentionDays)}
              disabled={saving}
              onPress={() => setChoosingRetention(true)}
            />
          </SettingsListPanel>
        </SettingsGroup>
      ) : null}
      <Sheet
        visible={choosingRetention}
        title="Keep unassigned meetings"
        onClose={() => setChoosingRetention(false)}
      >
        <SettingsListPanel>
          {RETENTION_CHOICES.map((count) => (
            <SettingsChoiceRow
              key={count}
              title={days(count)}
              selected={watch?.retentionDays === count}
              onPress={() => setRetention(count)}
            />
          ))}
        </SettingsListPanel>
      </Sheet>
    </SettingsScaffold>
  );
}
