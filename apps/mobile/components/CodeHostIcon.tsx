import type { CodeHostProvider } from '@verity/mobile';
import Svg, { Circle, Path } from 'react-native-svg';
import { Icon } from './Icon';

/**
 * The mark for a code host, drawn as a thin line glyph in one theme color so
 * GitHub and Forgejo sit in the same tile with the same weight. Feather has a
 * GitHub glyph; the Forgejo mark is the project's logo reduced to strokes.
 */
export function CodeHostIcon({
  provider,
  size = 18,
  color,
}: {
  provider: CodeHostProvider;
  size?: number;
  color: string;
}) {
  if (provider === 'github') return <Icon name="github" size={size} color={color} />;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      accessible={false}
    >
      <Path d="M7 18V9a5 5 0 0 1 5-5h3.5" />
      <Path d="M7 18v-1a5 5 0 0 1 5-5h3.5" />
      <Circle cx={17.5} cy={4} r={2} />
      <Circle cx={17.5} cy={12} r={2} />
      <Circle cx={7} cy={20} r={2} />
    </Svg>
  );
}
