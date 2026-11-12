// 16×16 icons, drawn in gilt deco. The drawings live in ./decoIcons; add a
// name to `IconName` and its path there.

import { CSSProperties } from 'react';
import { DECO_PATHS } from './decoIcons';

export type IconName =
  | 'gear' | 'plus' | 'x' | 'check' | 'arrow-right' | 'pause' | 'play'
  | 'bell' | 'folder' | 'terminal' | 'code' | 'web' | 'mcp' | 'sparkle'
  | 'expand' | 'minimize' | 'clock' | 'mic' | 'ledger' | 'info' | 'sidebar'
  | 'image' | 'edit' | 'git';

export interface IconProps {
  name: IconName;
  size?: number; // integer scale: 1 = 16px, 2 = 32px, ...
  style?: CSSProperties;
}

export function Icon({ name, size = 1, style }: IconProps) {
  const def = DECO_PATHS[name];
  const dim = 16 * size;
  return (
    <svg
      viewBox="0 0 16 16"
      width={dim}
      height={dim}
      style={{ display: 'inline-block', ...style }}
      aria-hidden
    >
      {def.accent && <path d={def.accent} fill={def.accentColor} fillRule="evenodd" />}
      {/* currentColor, not a hardcoded `--cth-ink-900`. `body` already sets that
          same token as its color, so this is a no-op for every icon sitting on a
          normal surface — but on an INVERTED surface it is the difference between
          an icon and a blank space. A primary PixelButton fills itself with
          `--cth-ink-900` and an icon painted the same token vanished into it (the
          arrow on Send, in both themes). Inheriting means an icon is always the
          colour of the text it sits beside, which is what every call site meant. */}
      <path d={def.ink} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
