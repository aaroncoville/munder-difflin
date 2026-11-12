// Design tokens for non-styled consumers (Pixi). The colour families here —
// cream, paper, ink, the accents and their -light fills, and status — mirror
// tokens.css both ways, held by a test. The aliases that only CSS needs
// (on-accent, hairline, gilt) live in tokens.css alone.
// Any change here must also update tokens.css.

export const colors = {
  // The panel palette: open Dracula values plus derived ground steps. The
  // derivations and contrast figures are written out in tokens.css.
  cream: {
    50: 0x282a36,
    100: 0x232530,
    200: 0x1e2029,
    300: 0x1a1b23
  },
  paper: {
    100: 0x323443,
    200: 0x21222c
  },
  ink: {
    900: 0xf8f8f2,
    700: 0xc4c9d7,
    500: 0x9ea8c3,
    300: 0x808db4,
    100: 0x44475a
  },
  accent: {
    coral: 0xff5555,
    coralLight: 0x57333d,
    mint: 0x50fa7b,
    mintLight: 0x315845,
    sky: 0x8be9fd,
    skyLight: 0x3e5462,
    lemon: 0xf1fa8c,
    lemonLight: 0x545849,
    lilac: 0xbd93f9,
    lilacLight: 0x494161,
    peach: 0xffb86c,
    peachLight: 0x574942
  },
  status: {
    idle: 0x808db4,
    thinking: 0x8be9fd,
    working: 0xf1fa8c,
    blocked: 0xff5555,
    success: 0x50fa7b,
    ghost: 0x717fac,
    waiting: 0xbd93f9,
    compacting: 0xff79c6,
    looping: 0xffb86c,
    typing: 0xf1fa8c
  },
  world: {
    grassLight: 0xd4eab0,
    grassDark: 0xb5d589,
    woodLight: 0xe5c896,
    woodDark: 0xc9a66b,
    path: 0xe8d8b0,
    wall: 0x8b6f47
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

export const type = {
  display: '"Press Start 2P", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", monospace',
  ui: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, "PingFang SC", "Microsoft YaHei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Geeza Pro", "Noto Naskh Arabic", "Segoe UI Historic", monospace'
} as const;

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
