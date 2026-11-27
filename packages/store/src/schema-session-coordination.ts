import type { Generated, JSONColumnType } from 'kysely';
import type { SessionCoordinationPhase } from './session-coordination.js';

interface SessionCoordinationRequestsTable {
  source_session_id: string;
  request_id: string;
  fingerprint: string;
  target_session_id: string;
  phase: Generated<SessionCoordinationPhase>;
  result: JSONColumnType<Record<string, unknown> | null>;
}

export interface SessionCoordinationDatabase {
  session_coordination_requests: SessionCoordinationRequestsTable;
}
