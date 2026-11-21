import type { Generated } from 'kysely';
import type { AssistantMode, AssistantRequestKind } from './assistant.js';

interface AssistantSettingsTable {
  id: number;
  enabled: Generated<boolean>;
  revision: Generated<number>;
  sponsor_user_id: string | null;
  session_id: string | null;
  updated_at: Generated<Date>;
}
interface AssistantProjectGrantsTable {
  project_id: string;
  mode: AssistantMode;
  sponsor_user_id: string;
  revision: Generated<number>;
  updated_at: Generated<Date>;
}
interface AssistantRequestsTable {
  request_id: string;
  session_id: string;
  user_id: string;
  kind: AssistantRequestKind;
  question_id: string | null;
  state: Generated<'pending' | 'accepted'>;
  created_at: Generated<Date>;
}
interface AssistantHandoffsTable {
  target_session_id: string;
  assistant_session_id: string;
  project_id: string;
  user_id: string | null;
  title: string;
  handed_off_at: Date;
}

export interface AssistantDatabase {
  assistant_settings: AssistantSettingsTable;
  assistant_project_grants: AssistantProjectGrantsTable;
  assistant_requests: AssistantRequestsTable;
  assistant_handoffs: AssistantHandoffsTable;
}
