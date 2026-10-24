import { StatusDot, StatusTag, type StatusIntent } from './ui/Status';

export type StatusPillIntent = StatusIntent;

/**
 * The former status pill, now drawn by the design system's status components
 * (docs/design-system.md § 5.4) until the screens using it are migrated: a
 * `quiet` pill sits in a list row and becomes a dot with a word, any other a
 * tag. `optional` is never a colored tag, so it is always the quiet form.
 */
export function StatusPill({
  label,
  intent,
  quiet = false,
}: {
  label: string;
  intent: StatusPillIntent;
  quiet?: boolean;
}) {
  return quiet || intent === 'optional' ? (
    <StatusDot intent={intent} label={label} />
  ) : (
    <StatusTag intent={intent} label={label} />
  );
}
