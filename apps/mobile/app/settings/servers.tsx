// Settings › Servers: the servers this app is connected to, for managing them.
// Their projects all appear in the one project list.
import { router } from 'expo-router';
import { useState } from 'react';

import { SettingsScaffold } from '../../components/settings/SettingsChrome';
import { serverLabel } from '../../components/home/OtherServerProjects';
import {
  Button,
  Group,
  Row,
  SectionHeader,
  Sheet,
  StatusTag,
  useConfirm,
} from '../../components/ui';
import {
  getOtherServerProfiles,
  getServerProfile,
  removeOtherServerProfile,
  type VerityServerProfile,
} from '../../lib/serverProfile';
import { switchToServer } from '../../lib/serverSwitch';

export default function ServersScreen() {
  return (
    <ServersView
      active={getServerProfile()}
      initialOthers={getOtherServerProfiles()}
      switchTo={switchToServer}
      remove={removeOtherServerProfile}
    />
  );
}

export function ServersView({
  active,
  initialOthers,
  switchTo,
  remove,
}: {
  active: VerityServerProfile | null;
  initialOthers: readonly VerityServerProfile[];
  switchTo: (serverId: string) => Promise<void>;
  remove: (serverId: string) => Promise<void>;
}) {
  const [others, setOthers] = useState(initialOthers);
  const [open, setOpen] = useState<VerityServerProfile | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [confirm, confirmSheet] = useConfirm();
  const all = [...(active === null ? [] : [active]), ...others];
  const own = all.filter((profile) => profile.sharedBy === undefined);
  const shared = all.filter((profile) => profile.sharedBy !== undefined);

  const row = (profile: VerityServerProfile) => {
    const isActive = profile.serverId === active?.serverId;
    return (
      <Row
        key={profile.serverId}
        leading={{ icon: profile.sharedBy === undefined ? 'server' : 'users', quiet: true }}
        title={serverLabel(profile)}
        subtitle={new URL(profile.activeUrl).host}
        trailing={isActive ? <StatusTag intent="ready" label="In use" /> : undefined}
        {...(isActive ? {} : { navigates: true, onPress: () => setOpen(profile) })}
      />
    );
  };
  const forget = (profile: VerityServerProfile) =>
    confirm({
      title: `Remove ${serverLabel(profile)}?`,
      message: 'This app stops showing its projects. You need a new invitation to return.',
      confirmLabel: 'Remove',
      destructive: true,
      afterSheet: true,
      onConfirm: async () => {
        await remove(profile.serverId);
        setOthers((current) => current.filter((entry) => entry.serverId !== profile.serverId));
      },
    });

  return (
    <SettingsScaffold title="Servers" detail state={{ error, saving: false }}>
      {own.length > 0 ? (
        <>
          <SectionHeader
            title={own.length === 1 ? 'Your server' : 'Your servers'}
            variant="eyebrow"
          />
          <Group>{own.map(row)}</Group>
        </>
      ) : null}
      {shared.length > 0 ? (
        <>
          <SectionHeader title="Shared with you" variant="eyebrow" />
          <Group>{shared.map(row)}</Group>
        </>
      ) : null}
      <Button
        label="Accept an invitation"
        icon="plus"
        variant="secondary"
        onPress={() => router.push('/onboarding/join')}
        fullWidth
      />
      <Sheet
        visible={open !== null}
        title={open === null ? '' : serverLabel(open)}
        onClose={() => setOpen(null)}
        footer={
          open === null ? undefined : (
            <Button
              label="Remove from this app"
              variant="destructive"
              onPress={() => {
                const profile = open;
                setOpen(null);
                forget(profile);
              }}
              fullWidth
            />
          )
        }
      >
        {open === null ? null : (
          <Group>
            <Row
              leading={{ icon: 'repeat', quiet: true }}
              title="Switch to this server"
              onPress={() => {
                const profile = open;
                setOpen(null);
                switchTo(profile.serverId).then(
                  () => router.replace('/'),
                  (caught: unknown) =>
                    setError(caught instanceof Error ? caught.message : 'Could not switch servers'),
                );
              }}
            />
          </Group>
        )}
      </Sheet>
      {confirmSheet}
    </SettingsScaffold>
  );
}
