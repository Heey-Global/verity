import {
  type ManagedDevServerSecretBinding,
  type ManagedDevServerInstanceRecord,
} from '@verity/store';
import type { ManagedServerProviderSnapshot } from './managed-dev-server-manager.js';

// What the app sees of a managed dev server and its running instances.

export interface ManagedInstanceView {
  id: string;
  sessionId: string;
  state: ManagedDevServerInstanceRecord['state'];
  desired: ManagedDevServerInstanceRecord['desired'];
  detail: string | null;
  /** The network address; set while the instance is published locally. */
  url: string | null;
  localShareId: string | null;
  /** Internal; the app uses it only as a share target and never displays it. */
  sandboxPort: number;
  /** True while running without the operator's approval for local publishing. */
  awaitingApproval: boolean;
  /** The Local switch: on while the operator wants it published on the network. A
   *  crash keeps it as it was; an unapproved command never reads as on. */
  localOn: boolean;
  /** The running command differs from the entry's current one. */
  restartToApply: boolean;
  startedAt: string | null;
}

export interface ManagedServerView {
  providerSnapshot?: ManagedServerProviderSnapshot | null | undefined;
  id: string;
  name: string;
  command: string;
  workdir: string;
  secretBindings: ManagedDevServerSecretBinding[];
  approved: boolean;
  /** This Core has the Local and Shared online switches (`/local`, `local` on
   *  start and approve). Lets newer apps fall back on older Cores. */
  accessSwitches: true;
  /** This session's instance, if the entry ever ran here. */
  instance: ManagedInstanceView | null;
  /** Running or starting instances in other sessions of the project. */
  elsewhere: Array<{ instanceId: string; sessionId: string; sessionName: string | null }>;
}
