import type { PublicPreviewShareState } from '@verity/store';

export interface CreatePreviewShareInput {
  managedInstanceId?: string | undefined;
  projectId?: string;
  sessionId?: string;
  devServerId?: string;
  staticPath?: string;
  /** A port something in the session's worktree listens on; requires `sessionId`. */
  targetPort?: number;
  pin: string;
  ttlSeconds: number;
}

export interface PublicPreviewShare {
  managedInstanceId: string | null;
  pinLocked?: boolean;
  id: string;
  projectId: string;
  devServerId: string | null;
  targetKind: 'dev-server' | 'static-folder';
  targetPort: number | null;
  staticPath: string | null;
  sessionId: string | null;
  state: PublicPreviewShareState;
  publicOrigin: string | null;
  pin: string;
  expiresAt: Date;
  revokedAt: Date | null;
  failure: string | null;
  createdAt: Date;
  updatedAt: Date;
}
