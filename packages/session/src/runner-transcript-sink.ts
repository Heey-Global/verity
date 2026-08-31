/**
 * Server-side transcript persistence port for the runner-supervisor path
 * (Stage 5b Slice 2).
 *
 * On the runner-supervisor path the Sandbox worker writes backend-native session
 * JSONL under a shared runner-runtime mount. The SERVER — which reads
 * that mount at its own host path — owns restore-before-resume and tail-into-DB, so
 * the in-sandbox worker needs no database of its own. The concrete implementation
 * lives in `@verity/server` (`ServerTranscript`); it is injected here as a narrow
 * port so `@verity/session` depends on neither the server nor the store.
 *
 * The on-disk path MUST use the backend session/thread id delivered by the
 * `session` frame. Durable rows use the canonical Verity store session id: ACP
 * adapters mint a distinct backend id, and `transcript_lines.session_id` is a
 * foreign key to that canonical session.
 */
export interface RunnerTranscriptSink {
  /**
   * Before a `--resume` turn launches: materialize the durable transcript back to
   * the shared `.jsonl` if it is missing, so the worker's `claude --resume` finds
   * it. Returns the byte offset (the restored file's size) the tail must start
   * from, so already-persisted lines are not re-appended. MUST resolve BEFORE the
   * supervisor is asked to start the worker.
   */
  restoreForResume(backendSessionId: string, cwd: string, storeSessionId: string): Promise<number>;
  /**
   * Tail the shared `.jsonl` into the durable store until `signal` aborts (a final
   * flush runs on abort). Started once the claude session id is known (the `session`
   * frame). `startOffset` skips bytes already persisted (0 for a fresh session, the
   * restored size for a resume).
   */
  tail(
    backendSessionId: string,
    cwd: string,
    storeSessionId: string,
    startOffset: number,
    signal: AbortSignal,
  ): Promise<void>;
}
