import type { OverviewStore, ProjectRecord, VerityClient } from '@verity/mobile';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getVerityBaseUrl } from './client';
import { useOverviewSelection } from './overviewTopics';

/** The projects a `/projects` read lists, as the server filters its overview:
 * any other project the store holds is not spoken for by that read. */
export function listedInOverview(project: ProjectRecord): boolean {
  return project.state !== 'absent' || project.overviewVisible === true;
}

const NO_PROJECTS: readonly ProjectRecord[] = [];

/**
 * The overview's projects from the shared store (ADR 0033) while `active`,
 * for a view that is not Home, such as a session's settings. Each activation
 * reads them once into the store, so this view and Home show the same copy
 * and events change both; until the store holds that read, the read itself is
 * shown.
 */
export function useOverviewProjects(client: VerityClient, active: boolean): ProjectRecord[] {
  // Projects only while shown, so a closed sheet does not render its screen.
  const [store, held] = useOverviewSelection(getVerityBaseUrl(), (overview) =>
    active ? overview.projects() : NO_PROJECTS,
  );
  const storeRef = useRef(store);
  storeRef.current = store;
  /** The last read, and the store that took it, if one did. */
  const [own, setOwn] = useState<{ projects: ProjectRecord[]; store?: OverviewStore }>({
    projects: [],
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
        setOwn(applied ? { projects, store: target } : { projects });
      })
      .catch(() => undefined)
      .finally(() => target.endRead(read));
    return () => {
      current = false;
    };
  }, [client, active]);
  // In the order of the read, as `/projects` lists them; then the projects
  // other views read since.
  return useMemo(() => {
    // Another store (an account change) holds none of this read.
    if (own.store !== store) return own.projects;
    const byId = new Map(held.filter(listedInOverview).map((project) => [project.id, project]));
    const shown = own.projects.flatMap((project) => {
      const copy = byId.get(project.id);
      byId.delete(project.id);
      return copy === undefined ? [] : [copy];
    });
    return [...shown, ...byId.values()];
  }, [own, held, store]);
}
