import type { ProjectRecord, VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getVerityBaseUrl } from './client';
import { useOverviewStore } from './overviewTopics';

/** The projects a `/projects` read lists, as the server filters its overview:
 * any other project the store holds is not spoken for by that read. */
export function listedInOverview(project: ProjectRecord): boolean {
  return project.state !== 'absent' || project.overviewVisible === true;
}

/**
 * The overview's projects from the shared store (ADR 0033) while `active`,
 * for a view that is not Home, such as a session's settings. Each activation
 * reads them once into the store, so this view and Home show the same copy
 * and events change both; until the store holds that read, the read itself is
 * shown.
 */
export function useOverviewProjects(client: VerityClient, active: boolean): ProjectRecord[] {
  const store = useOverviewStore(getVerityBaseUrl());
  const storeRef = useRef(store);
  storeRef.current = store;
  const [own, setOwn] = useState<{ projects: ProjectRecord[]; inStore: boolean }>({
    projects: [],
    inStore: false,
  });
  useEffect(() => {
    if (!active) return undefined;
    let current = true;
    const target = storeRef.current;
    const read = target.beginRead();
    void client
      .listProjects()
      .then((projects) => {
        if (!current) return;
        const applied = target.applyProjects(read, projects, { covers: listedInOverview });
        setOwn({ projects, inStore: applied && target === storeRef.current });
      })
      .catch(() => undefined)
      .finally(() => target.endRead(read));
    return () => {
      current = false;
    };
  }, [client, active]);
  const held = store.projects();
  return useMemo(() => (own.inStore ? held.filter(listedInOverview) : own.projects), [own, held]);
}
