// Design module: mockups the user approves before the rest of a plan is built.
// The project's design level decides when a plan lists mockups; the server keeps
// the order (present, review, approve) and the agent builds and renders them.
import {
  COMPLETE_MOCKUPS_FOCUSED_TOOL,
  COMPLETE_MOCKUPS_TOOL,
  PRESENT_MOCKUPS_FOCUSED_TOOL,
  PRESENT_MOCKUPS_TOOL,
} from './planning.js';

/** Agents see the focused or the gateway name depending on their tool set. */
const PRESENT = `\`${PRESENT_MOCKUPS_FOCUSED_TOOL}\` (\`${PRESENT_MOCKUPS_TOOL}\` in tool sets without focused names)`;
const COMPLETE = `\`${COMPLETE_MOCKUPS_FOCUSED_TOOL}\` (\`${COMPLETE_MOCKUPS_TOOL}\` in tool sets without focused names)`;

/** `off`: no mockups. `on_request`: only when the user asks for them.
 *  `required`: every plan that changes the user interface includes them. */
export type DesignLevel = 'off' | 'on_request' | 'required';

/** Returned when planning starts, so the plan follows the project's design level. */
export function planningDesignNote(level: DesignLevel): string {
  switch (level) {
    case 'off':
      return "This project's Design module is off: do not add a Mockups section unless the user asks for mockups.";
    case 'on_request':
      return "Add a Mockups section only if the user asks for mockups; this project's Design module makes them optional.";
    case 'required':
      return "This project's Design module requires mockups: if the plan adds or changes any user interface, include a Mockups section that lists each affected screen.";
  }
}

/** Appended to the implementation prompt when the accepted plan lists mockups. */
export const MOCKUPS_FIRST_PROMPT = `The plan lists mockups. Build only those first, without implementing the rest of the plan: render each listed screen as its own PNG or JPEG file in this worktree (one screen per image, composed from the app's real components and design tokens; use the project's own mockup tooling where it has one), then call ${PRESENT} with a short name and the relative path of each image, and end your turn. The user marks each screen as approved or discarded and tells you in the chat what to change. A revision replaces the round: present every screen again with ${PRESENT}, not as images in the chat. Continue with the rest of the plan only after the user tells you in the chat to implement; then call ${COMPLETE} first.`;

/** One screen of the round under review, as the agent is told about it. */
export interface MockupMark {
  name: string;
  verdict: 'open' | 'approved' | 'discarded';
}

/**
 * Turn context while a round waits for review: the user's marks and what they
 * allow. Marks only record the user's opinion; the user starts the build in the
 * chat. Empty when no round is under review.
 */
export function mockupReviewPrompt(
  review: { state: string | null; screens: readonly MockupMark[] } | undefined,
): string {
  if (review?.state !== 'pending' || review.screens.length === 0) return '';
  const label = { open: 'not marked yet', approved: 'approved', discarded: 'discarded' } as const;
  const lines = review.screens.map((screen) => `- ${screen.name}: ${label[screen.verdict]}`);
  return `## Mockup review\nThe mockups you presented are under review. The user's current marks:\n${lines.join('\n')}\n\nMarks are opinions, not instructions to build: the user explains them in the chat. To revise, render the changed screens and present the whole round again with ${PRESENT}; drop or redo discarded screens as the user asks. Do not implement the rest of the plan until the user tells you in the chat to implement. When they do, call ${COMPLETE} before you continue; it ends the review.`;
}
