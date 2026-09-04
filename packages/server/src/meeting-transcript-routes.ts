import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { sessionParams } from './session-route-schemas.js';

/** Caps the JSON upload route at roughly a 52 MiB recording once base64 is
 *  decoded. `buildServer` reads this to size Fastify's own body limit, which
 *  takes the larger of this and the attachment cap plus an envelope allowance,
 *  because a body limit at or below this one rejects a legal recording before
 *  any schema runs and the client sees a bare 413 instead of a field error. */
export const MAX_MEETING_AUDIO_BASE64_LEN = 70_000_000;

// `fileName` is bounded but not shape-checked, here or on the streamed route:
// it is a label, not a path. The handlers derive the stored name from
// `extname()` stripped to `[A-Za-z0-9.]` and the title from `basename()`, so a
// traversal-shaped name never reaches the filesystem — and a schema that
// rejected one would only be turning a harmless string into a failed upload.
const meetingTranscriptBody = z.object({
  fileName: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100).default('audio/mpeg'),
  data: z.string().min(1).max(MAX_MEETING_AUDIO_BASE64_LEN),
  title: z.string().min(1).max(120).optional(),
  announceRequest: z.boolean().optional(),
  clientRequestId: z.string().min(1).max(100).optional(),
});

const streamedMeetingMetadata = z.object({
  fileName: z.string().min(1).max(200),
  // The default never fires on this route — its media type arrives in a required
  // header, so an omission is a 400 before this schema runs. It is kept so the
  // decoded shape stays assignable to the same handler contract as the JSON
  // upload, where the field really is optional.
  mediaType: z.string().min(1).max(100).default('audio/mpeg'),
  title: z.string().min(1).max(120).optional(),
  announceRequest: z.enum(['true', 'false']).optional(),
  clientRequestId: z.string().min(1).max(100).optional(),
});

const streamedMeetingTranscriptHeaders = z.object({
  'x-verity-meeting-file-name': z.string().min(1),
  'x-verity-meeting-media-type': z.string().min(1),
  'x-verity-meeting-title': z.string().optional(),
  'x-verity-meeting-announce': z.enum(['true', 'false']).optional(),
  // encodeURIComponent can expand one Unicode code point to 12 ASCII bytes.
  // `streamedMeetingMetadata` above remains the authoritative 100-char
  // limit, applied to the decoded value.
  'x-verity-meeting-client-request-id': z.string().min(1).max(1200).optional(),
});

type MeetingTranscriptUpload = z.infer<typeof meetingTranscriptBody>;
type StreamedMeetingMetadata = z.infer<typeof streamedMeetingMetadata>;

export interface MeetingTranscriptCreated {
  path: string;
  title: string;
  segments: number;
}

export interface MeetingTranscriptRouteDeps {
  /** Transcribes a recording uploaded as base64 JSON and returns the saved file. */
  save: (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    upload: MeetingTranscriptUpload,
  ) => Promise<MeetingTranscriptCreated | { error: string }>;
  /** Streams a recording to disk, acknowledges, and transcribes it afterwards. */
  stream: (
    request: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    metadata: StreamedMeetingMetadata,
  ) => Promise<{ accepted: true } | { error: string }>;
}

/**
 * Registers the two ways a recording reaches a session.
 *
 * The streamed route carries its metadata in headers because its body is the
 * audio itself, so the file name and title arrive percent-encoded — a code point
 * that survives `encodeURIComponent` but not the round trip is a client bug, and
 * it has to read as a 400 rather than the 500 an unhandled `URIError` would
 * become.
 */
export function registerMeetingTranscriptRoutes(
  app: FastifyInstance,
  deps: MeetingTranscriptRouteDeps,
): void {
  app.post(
    '/sessions/:id/meetings/transcripts',
    async (request, reply): Promise<MeetingTranscriptCreated | { error: string }> => {
      const { id } = sessionParams.parse(request.params);
      return deps.save(request, reply, id, meetingTranscriptBody.parse(request.body));
    },
  );

  // Large recordings are streamed to disk and acknowledged as soon as upload
  // finishes. Transcription then continues independently of the mobile request.
  app.post(
    '/sessions/:id/meetings/transcripts/stream',
    async (request, reply): Promise<{ accepted: true } | { error: string }> => {
      const { id } = sessionParams.parse(request.params);
      const headers = streamedMeetingTranscriptHeaders.parse(request.headers);
      let metadata: StreamedMeetingMetadata;
      try {
        metadata = streamedMeetingMetadata.parse({
          fileName: decodeURIComponent(headers['x-verity-meeting-file-name']),
          mediaType: decodeURIComponent(headers['x-verity-meeting-media-type']),
          ...(headers['x-verity-meeting-title']
            ? { title: decodeURIComponent(headers['x-verity-meeting-title']) }
            : {}),
          ...(headers['x-verity-meeting-announce']
            ? { announceRequest: headers['x-verity-meeting-announce'] }
            : {}),
          ...(headers['x-verity-meeting-client-request-id']
            ? {
                clientRequestId: decodeURIComponent(headers['x-verity-meeting-client-request-id']),
              }
            : {}),
        });
      } catch (error) {
        if (error instanceof URIError) {
          reply.code(400);
          return { error: 'invalid meeting metadata encoding' };
        }
        throw error;
      }
      return deps.stream(request, reply, id, metadata);
    },
  );
}
