import type { Attachment } from '@verity/events';
import { type SessionDetail, type TurnRequest } from '../api.js';
import type { SessionState } from '../reducer.js';
import { engineLabel } from '../ui/modelPicker.js';

// Shapes the session detail before the model stores it.

/** An outgoing {@link TurnRequest} attachment as the transcript renders it. The
 * upload shape (inline base64) is a valid persisted attachment, so the local echo
 * shows the real thumbnails while the send is in flight; once the `prompt` event
 * lands the transcript's own (content-addressed) attachments take over. */
export function toDisplayAttachment(
  upload: NonNullable<TurnRequest['attachments']>[number],
): Attachment {
  return upload.kind === 'file'
    ? {
        kind: 'file',
        mediaType: upload.mediaType,
        fileName: upload.fileName,
        data: upload.data,
      }
    : { kind: 'image', mediaType: upload.mediaType, data: upload.data };
}

export function normalizeDetailRateLimit(
  detail: SessionDetail,
  currentModel: string | undefined,
): SessionState['rateLimit'] {
  const rateLimits = detail.rateLimits ?? (detail.rateLimit ? [detail.rateLimit] : []);
  const currentProvider = engineLabel(currentModel);
  const rateLimit = rateLimits
    .filter(
      (r) =>
        (r.providerLabel ?? 'Claude') === currentProvider &&
        (r.scope === undefined || r.scope === 'all_models'),
    )
    .sort((a, b) => {
      const activeDelta = Number(a.status === 'allowed') - Number(b.status === 'allowed');
      if (activeDelta !== 0) return activeDelta;
      return b.resetsAt - a.resetsAt;
    })[0];
  if (rateLimit === undefined) return undefined;
  const providerLabel = rateLimit.providerLabel ?? 'Claude';
  return {
    status: rateLimit.status,
    resetsAt: rateLimit.resetsAt,
    window: rateLimit.window,
    ...(rateLimit.usedPercent !== undefined ? { usedPercent: rateLimit.usedPercent } : {}),
    providerLabel,
  };
}
