import type { ConfirmRequest } from '../components/ui';

/**
 * The confirmation for deleting a session, the same wherever it is asked.
 * Deleting means done, not worthless: a project session is offered for its
 * Wiki by default. Its conversation is then kept until Verity has read it for
 * the Wiki; nothing is copied into the project's knowledge. A session outside
 * a project has no Wiki, so it is not asked.
 */
export function deleteSessionRequest(
  session: { label: string; projectId: string | null; automation?: boolean },
  onDelete: (options: { wiki: boolean }) => void | Promise<void>,
  /** Asked right after closing another sheet (settings, rename). */
  afterSheet = false,
): ConfirmRequest {
  return {
    title: 'Delete session?',
    // The switch below says what stays for the Wiki; the session itself is gone.
    message: `This removes "${session.label}" from your sessions with its${session.automation ? ' automation and' : ''} worktree. This can't be undone.`,
    ...(afterSheet ? { afterSheet } : {}),
    confirmLabel: 'Delete',
    destructive: true,
    ...(session.projectId
      ? {
          option: {
            title: 'Use for the Wiki',
            subtitle: 'Its conversation is kept until Verity has reviewed it for the Wiki',
            initial: true,
          },
        }
      : {}),
    onConfirm: (wiki) => onDelete({ wiki: session.projectId !== null && wiki }),
  };
}
