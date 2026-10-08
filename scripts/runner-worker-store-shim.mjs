// The worker uses the wire constant and pure redaction helpers; PostgreSQL remains Server-only.
export const RUNNER_FRAME_PROTOCOL_VERSION = 1;

export { redactProcessStderr } from '../packages/store/dist/redact.js';
