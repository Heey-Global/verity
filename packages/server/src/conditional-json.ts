import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';

/**
 * Overview reads (`/sessions`, `/projects`, `/projects/:id`) are re-read by
 * every device after each live hint or invalidation. Most of those reads return
 * the body the device already holds, and each one used to cross the network in
 * full and uncompressed. A validator lets an unchanged read answer
 * `304 Not Modified` with no body, and gzip shrinks the reads that did change.
 *
 * The tag is weak (`W/`) because it names the JSON representation, not the
 * compressed bytes on the wire. Every response is personal, so it is marked
 * `private, no-cache`: caches may keep it, but must revalidate with us.
 */
function conditionalJsonOnSend(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  if (reply.statusCode !== 200 || typeof payload !== 'string') {
    done(null, payload);
    return;
  }
  const etag = `W/"${createHash('sha256').update(payload).digest('base64url').slice(0, 32)}"`;
  reply.header('etag', etag);
  reply.header('cache-control', 'private, no-cache');
  if (ifNoneMatch(request.headers['if-none-match'], etag)) {
    reply.code(304);
    reply.removeHeader('content-type');
    reply.removeHeader('content-length');
    done(null, '');
    return;
  }
  done(null, payload);
}

function ifNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  // Weak comparison (RFC 9110 §13.1.2): only the opaque tag has to match.
  const opaque = etag.replace(/^W\//u, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//u, ''))
    .some((candidate) => candidate === opaque || candidate === '*');
}

/** Route options for a compressed, conditionally answered JSON read. The
 * validator hook runs before the compression hook, which compress appends. */
export const conditionalJsonRoute = {
  compress: { encodings: ['gzip', 'deflate'] },
  onSend: conditionalJsonOnSend,
} satisfies RouteShorthandOptions;
