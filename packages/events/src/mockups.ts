// Design module: mockups the user approves before the rest of a plan is built.
// The project's design level decides when a plan lists mockups; the server keeps
// the order (present, review, approve) and the agent builds and renders them.
import { PRESENT_MOCKUPS_FOCUSED_TOOL, PRESENT_MOCKUPS_TOOL } from './planning.js';

/** Agents see the focused or the gateway name depending on their tool set. */
const PRESENT = `\`${PRESENT_MOCKUPS_FOCUSED_TOOL}\` (\`${PRESENT_MOCKUPS_TOOL}\` in tool sets without focused names)`;

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
export const MOCKUPS_FIRST_PROMPT = `The plan lists mockups. Build only those first, without implementing the rest of the plan: render each listed screen as a PNG or JPEG file in this worktree (use the project's own mockup tooling where it has one), then call ${PRESENT} with a short name and the relative path of each image, and end your turn. Verity shows them to the user for review. Continue with the remaining steps only after Verity tells you every screen was approved; when the user comments instead, revise the affected screens and present all of them again.`;

/** Server-dispatched turn once every screen of the current round is approved. */
export const MOCKUPS_APPROVED_PROMPT =
  'The user approved all mockups you presented. Continue implementing the accepted plan, keeping the screens as approved.';
export const MOCKUPS_APPROVED_DISPLAY = 'Mockups approved';

export interface MockupFeedback {
  name: string;
  verdict: 'open' | 'approved' | 'comment';
  comment?: string;
}

/** Server-dispatched turn carrying the reviewer's comments on one round. */
export function mockupFeedbackPrompt(screens: readonly MockupFeedback[]): string {
  const lines = screens.map((screen) =>
    screen.verdict === 'comment'
      ? `- ${screen.name}: ${screen.comment ?? ''}`
      : `- ${screen.name}: ${screen.verdict === 'approved' ? 'approved' : 'not reviewed yet'}`,
  );
  return `The user reviewed the mockups and left comments:\n${lines.join('\n')}\n\nRevise the commented screens, keep approved ones unchanged, and present all screens again with ${PRESENT}. Do not implement the rest of the plan yet.`;
}

export function mockupFeedbackDisplay(comments: number): string {
  return comments === 1 ? '1 mockup comment' : `${String(comments)} mockup comments`;
}
