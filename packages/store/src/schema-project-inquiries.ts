import type { Generated } from 'kysely';

export interface ProjectInquiryGrantsTable {
  source_project_id: string;
  target_project_id: string;
  enabled: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface ProjectInquirySessionsTable {
  source_session_id: string;
  target_project_id: string;
  target_session_id: string;
  change_approved: Generated<boolean>;
}

export interface ProjectInquiriesTable {
  id: string;
  source_session_id: string;
  target_session_id: string;
  source_project_id: string;
  target_project_id: string;
  title: string;
  body: string;
  kind: 'question' | 'change';
  status: 'provisioning' | 'pending' | 'approved' | 'rejected' | 'queued' | 'answered' | 'blocked';
  created_at: Generated<Date>;
  answer: string | null;
  answer_delivered: Generated<boolean>;
  user_id: string | null;
  decided_by: string | null;
  human_approved: Generated<boolean>;
}

export interface ProjectInquiryDatabase {
  project_inquiry_grants: ProjectInquiryGrantsTable;
  project_inquiry_sessions: ProjectInquirySessionsTable;
  project_inquiries: ProjectInquiriesTable;
}
