// Projects of the other servers this app knows, in the same project list as the
// active server's (ADR 0023 §7). A project shared from someone else's server
// names whose it is; opening one switches the app to that server.
import { projectTitle, type ProjectRecord } from '@verity/mobile';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { createVerityClientForProfile } from '../../lib/client';
import { getOtherServerProfiles, type VerityServerProfile } from '../../lib/serverProfile';
import { switchToServer } from '../../lib/serverSwitch';
import { Group, Row, Text } from '../ui';

interface ServerProjects {
  profile: VerityServerProfile;
  /** Undefined while the server is locked or unreachable from here. */
  projects?: ProjectRecord[];
}

export function serverLabel(profile: VerityServerProfile): string {
  return profile.sharedBy ?? new URL(profile.activeUrl).hostname;
}

function Initial({ name }: { name: string }) {
  return (
    <Text variant="row" tone="action">
      {(Array.from(name)[0] ?? '?').toUpperCase()}
    </Text>
  );
}

export function OtherServerProjects({
  profiles = getOtherServerProfiles(),
  clientFor = createVerityClientForProfile,
  open = (serverId: string, projectId?: string) =>
    void switchToServer(serverId).then(() => {
      if (projectId !== undefined)
        router.push({ pathname: '/project/[id]', params: { id: projectId } });
    }),
}: {
  profiles?: readonly VerityServerProfile[];
  clientFor?: typeof createVerityClientForProfile;
  open?: (serverId: string, projectId?: string) => void;
}) {
  const [servers, setServers] = useState<ServerProjects[]>(() =>
    profiles.map((profile) => ({ profile })),
  );
  useEffect(() => {
    let active = true;
    for (const profile of profiles) {
      const client = clientFor(profile);
      if (client === null) continue;
      client
        .listProjects()
        .then((projects) => {
          if (!active) return;
          setServers((current) =>
            current.map((entry) =>
              entry.profile.serverId === profile.serverId
                ? {
                    profile,
                    projects: projects.filter(
                      (project) => project.state === 'active' && project.archived !== true,
                    ),
                  }
                : entry,
            ),
          );
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [profiles, clientFor]);

  if (servers.length === 0) return null;
  return (
    <Group>
      {servers.flatMap(({ profile, projects }) => {
        const origin =
          profile.sharedBy === undefined
            ? `on ${serverLabel(profile)}`
            : `from ${profile.sharedBy}`;
        if (projects === undefined)
          return [
            <Row
              key={profile.serverId}
              leading={{ icon: 'server', quiet: true }}
              title={serverLabel(profile)}
              subtitle="Open to see its projects"
              navigates
              onPress={() => open(profile.serverId)}
            />,
          ];
        return projects.map((project) => {
          const title = projectTitle(project);
          return (
            <Row
              key={`${profile.serverId}:${project.id}`}
              leading={{ element: <Initial name={title} /> }}
              title={title}
              subtitle={origin}
              navigates
              onPress={() => open(profile.serverId, project.id)}
            />
          );
        });
      })}
    </Group>
  );
}
