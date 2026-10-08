import { type IntegrationSource } from '@verity/mobile';

/** Rooms bound elsewhere must never appear as invitations for this project. */
export function projectMatrixRooms(sources: IntegrationSource[], projectId: string) {
  return {
    connected: sources.filter((source) => source.projectId === projectId),
    invitations: sources.filter((source) => source.status === 'pending' && !source.projectId),
  };
}
