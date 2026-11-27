import { PROJECTS_COLLECTION_TOPIC, type DomainEvent } from '@verity/mobile';
import { useEffect, useRef } from 'react';
import { liveConnectionFor } from './liveConnection';

export interface ProjectCollectionHandlers {
  /** The project entered the overview: created or restored. */
  listed(projectId: string): void;
  /** The project left the overview: hidden or deleted. */
  unlisted(projectId: string): void;
  /** Changes were missed: read the whole list again. */
  resync(): void;
}

/**
 * Follow which projects the overview lists (ADR 0033): the server announces a
 * project entering or leaving it, filtered to those this account may read, so
 * a project created on another device shows without reading the list again.
 */
export function useProjectCollection(
  baseUrl: string | null,
  handlers: ProjectCollectionHandlers,
): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    if (baseUrl === null) return undefined;
    return liveConnectionFor(baseUrl).subscribeTopic(PROJECTS_COLLECTION_TOPIC, {
      event: (event: DomainEvent) => {
        if (event.t === 'project.listed') current.current.listed(event.projectId);
        else if (event.t === 'project.unlisted') current.current.unlisted(event.projectId);
      },
      resync: () => current.current.resync(),
    });
  }, [baseUrl]);
}
