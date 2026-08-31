// Build-time switches for entry points that are gated independently of the code
// behind them. A flag flip is the whole change — the feature's implementation
// stays in place either way, so nothing has to be rebuilt to turn one on or off.
// These are plain JS constants, so a flip ships over the air (mobile-ota.yml);
// no native build is involved.

/** Header task icon and the `/plan` GitHub Projects backlog it opens. */
export const TASKS_ENABLED: boolean = false;

/** "Meeting audio" row in the composer's attach menu (audio transcription).
 * Enabled: the upload → transcription → `docs/meetings/*.md` round trip is wired
 * end to end (server route, bundled transcriber client). Transcription needs a
 * remote OpenAI-compatible backend configured on the server; when none is, the
 * route answers with an explicit in-chat notice rather than failing silently. */
export const MEETING_AUDIO_ENABLED: boolean = true;
