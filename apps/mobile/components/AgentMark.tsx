import type { SessionAgentMark } from '@verity/mobile';
import { View } from 'react-native';

import { TileMark, type TileMarkGlyph, type TileMarkTone } from './ui';

/**
 * How an agent's state is drawn on a tile's top corner: on a session row in a
 * project's Work list and on a project card alike, so "?", the magenta pulse
 * and blue mean the same wherever they appear (docs/design-system.md § 5.2).
 * The labels are the ones the rows' old leading dots carried, kept so VoiceOver
 * says the same.
 */
export const AGENT_MARK: Record<
  SessionAgentMark,
  { tone: TileMarkTone; glyph?: TileMarkGlyph; pulsing?: boolean; label: string }
> = {
  question: { tone: 'attention', glyph: '?', label: 'Waiting for you' },
  working: { tone: 'signature', pulsing: true, label: 'Agent is working' },
  unread: { tone: 'action', label: 'Unread messages' },
};

/** The agent mark as a spoken image, for a tile's `marks.top` or corner slot. */
export function AgentTileMark({ mark, testID }: { mark: SessionAgentMark; testID?: string }) {
  const spec = AGENT_MARK[mark];
  return (
    <View testID={testID} accessibilityRole="image" accessibilityLabel={spec.label}>
      <TileMark tone={spec.tone} glyph={spec.glyph} pulsing={spec.pulsing === true} />
    </View>
  );
}
