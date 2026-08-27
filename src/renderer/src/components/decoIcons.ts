/**
 * The icon set redrawn in gilt deco, for the occult theme.
 *
 * Same twenty-four names, same 16×16 viewBox, same `IconDef` shape and the same
 * `currentColor` ink — so every one of the call sites that renders an `Icon`
 * stays exactly as written and simply gets a different drawing under the
 * Study's theme.
 *
 * What changes is the idiom, and it changes in two ways that go together. The
 * pixel set is built from integer horizontal and vertical runs and renders with
 * `shapeRendering="crispEdges"`, which snaps every edge to the device pixel —
 * that is what keeps a 16px pixel-art glyph from shimmering. These are built
 * from arcs and quadratics on a continuous grid, and crisp edges are exactly
 * wrong for them: snapping turns a swept curve into a staircase. `Icon` drops
 * the hint along with the table, because a deco path rendered with the pixel
 * set's instruction is neither.
 *
 * Drawing conventions, so the set stays one set:
 *
 *   - Outlines are drawn as rings — an outer subpath and an inner one, cut by
 *     `fill-rule: evenodd`, the same trick the pixel gear's hub hole uses. A
 *     shape drawn INSIDE such a hole lands on an odd crossing count and fills
 *     back in, which is how the page's ruled lines and the frame's horizon sit
 *     inside their own frames.
 *   - Terminals are rounded rather than cut square; arms flare toward their
 *     ends. That taper is most of what reads as deco at this size.
 *   - Symmetry about the vertical axis wherever the glyph allows it.
 *   - Nothing thinner than about 0.6 units, because a hairline at 16px on a
 *     dark ground disappears before it looks delicate.
 */
import type { IconName } from './Icon';

/** Same shape `Icon.tsx`'s own table uses — see `IconDef` there. */
export interface DecoIconDef {
  ink: string;
  accent?: string;
  accentColor: string;
}

export const DECO_PATHS: Record<IconName, DecoIconDef> = {
  // A ring, eight teeth tapering outward from it, and a hub disc sitting in the
  // ring's own hole — where an odd crossing count fills it back in. Generated
  // eight-fold rather than drawn by eye, because a cog whose teeth are a degree
  // out reads as a splat at 16px.
  gear: {
    accentColor: 'var(--cth-ink-300)',
    ink: 'M8 1.7a6.3 6.3 0 1 0 0 12.6a6.3 6.3 0 1 0 0-12.6zM8 3.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9zM8 5.9a2.1 2.1 0 1 1 0 4.2a2.1 2.1 0 1 1 0-4.2zM5.9 2.06L6.51 0.65L9.49 0.65L10.1 2.06zM10.71 2.31L12.14 1.75L14.25 3.86L13.69 5.29zM13.94 5.9L15.35 6.51L15.35 9.49L13.94 10.1zM13.69 10.71L14.25 12.14L12.14 14.25L10.71 13.69zM10.1 13.94L9.49 15.35L6.51 15.35L5.9 13.94zM5.29 13.69L3.86 14.25L1.75 12.14L2.31 10.71zM2.06 10.1L0.65 9.49L0.65 6.51L2.06 5.9zM2.31 5.29L1.75 3.86L3.86 1.75L5.29 2.31z'
  },
  // A cross whose arms widen where they meet, the way a deco rule swells at a
  // junction. The pixel plus is four square runs; this is one closed outline.
  plus: {
    accentColor: 'var(--cth-mint)',
    ink: 'M7 1.6q1 0 2 0q0 2.6 0.4 3.4q0.8 0.4 3.4 0.4q0 1 0 2q-2.6 0-3.4 0.4q-0.4 0.8-0.4 3.4q-1 0-2 0q0-2.6-0.4-3.4q-0.8-0.4-3.4-0.4q0-1 0-2q2.6 0 3.4-0.4q0.4-0.8 0.4-3.4z'
  },
  // A saltire with rounded caps — the ends are half-circles, so the stroke
  // reads as drawn with a nib rather than cut from a grid.
  x: {
    accentColor: 'var(--cth-coral)',
    ink: 'M4 2.6a1.1 1.1 0 0 0-1.5 1.5L6.4 8l-3.9 3.9a1.1 1.1 0 1 0 1.5 1.5L8 9.5l3.9 3.9a1.1 1.1 0 0 0 1.5-1.5L9.5 8l3.9-3.9a1.1 1.1 0 0 0-1.5-1.5L8 6.4z'
  },
  // One unbroken swept tick: the long arm tapers as it rises, which is the only
  // way a check reads as written rather than ticked off.
  check: {
    accentColor: 'var(--cth-mint)',
    ink: 'M14.3 3.2q0.9 0.7 0.3 1.6L7.4 13.3q-0.6 0.8-1.5 0.3L1.6 9.6q-0.8-0.8 0-1.6q0.8-0.8 1.6 0l3.2 3.1L12.7 3.5q0.7-0.9 1.6-0.3z'
  },
  // A thin shaft with a leaf-shaped head, rather than the pixel set's solid
  // wedge — at this size the shaft is what gives it direction.
  'arrow-right': {
    accentColor: 'var(--cth-sky)',
    ink: 'M2.4 7h7.3L7.2 4.4q-0.7-0.8 0.1-1.5q0.8-0.7 1.5 0.1l4.2 4.4q0.5 0.6 0 1.2l-4.2 4.4q-0.7 0.8-1.5 0.1q-0.8-0.7-0.1-1.5L9.7 9H2.4q-1 0-1-1q0-1 1-1z'
  },
  // A page with the quill laid across its top-right corner, keeping the pixel
  // edit's composition — two whole objects, one crossing the other — in a hand
  // the rest of this set is drawn in.
  edit: {
    accentColor: 'var(--cth-lilac)',
    ink: 'M2.4 1.6h6.2q0.6 0 0.6 0.6q0 0.6-0.6 0.6H3v11.2h8.4V9.6q0-0.6 0.6-0.6q0.6 0 0.6 0.6v5q0 0.8-0.8 0.8H2.4q-0.8 0-0.8-0.8V2.4q0-0.8 0.8-0.8zM13.6 1.2q1.2 1.2 0 2.4L8.7 8.5q-0.2 0.2-0.5 0.3l-2 0.5q-0.6 0.2-0.4-0.5l0.5-2q0.1-0.3 0.3-0.5l4.9-4.9q1.2-1.2 2.4 0z'
  },
  // Two columns, each swelling slightly at the waist and rounded at both ends.
  pause: {
    accentColor: 'var(--cth-lemon)',
    ink: 'M5 2.6q1.4 0 1.4 1.4v8q0 1.4-1.4 1.4q-1.4 0-1.4-1.4v-8q0-1.4 1.4-1.4zM11 2.6q1.4 0 1.4 1.4v8q0 1.4-1.4 1.4q-1.4 0-1.4-1.4v-8q0-1.4 1.4-1.4z'
  },
  // A triangle with a bowed back edge and a rounded apex — the straight-sided
  // version reads as a media control, this reads as a pointer in a frontispiece.
  play: {
    accentColor: 'var(--cth-mint)',
    ink: 'M4.4 2.7q0-1.3 1.1-0.7l7.4 4.7q0.9 0.6 0 1.3l-7.4 4.7q-1.1 0.6-1.1-0.7q0.5-4.7 0-9.3z'
  },
  // A bell whose skirt sweeps out rather than stepping out, with the clapper as
  // a separate rounded shape beneath it.
  bell: {
    accentColor: 'var(--cth-peach)',
    ink: 'M8 1q0.9 0 0.9 0.9q3.1 0.8 3.1 4.3q0 2.6 1.3 4q0.5 0.6-0.3 0.6H3q-0.8 0-0.3-0.6q1.3-1.4 1.3-4q0-3.5 3.1-4.3q0-0.9 0.9-0.9zM6.2 12.2h3.6q-0.2 2-1.8 2q-1.6 0-1.8-2z'
  },
  // Drawn as an outline — outer edge and inner edge cut against each other — so
  // it reads at the same weight as the framed glyphs beside it.
  folder: {
    accentColor: 'var(--cth-lemon)',
    ink: 'M1.6 3.4q0-1 1-1h3.6q0.6 0 1 0.5l0.9 1.2h5.3q1 0 1 1v7.5q0 1-1 1H2.6q-1 0-1-1zM3 4.6v6.9h10V5.9H8.1q-0.5 0-0.8-0.4l-1-1.3z'
  },
  // A framed picture: the horizon inside it is drawn within the frame's own
  // hole, so it lands on an odd crossing count and fills.
  image: {
    accentColor: 'var(--cth-lemon)',
    accent: 'M5.2 5.4a1.15 1.15 0 1 1 0 2.3a1.15 1.15 0 1 1 0-2.3z',
    ink: 'M2 2.2h12q1.2 0 1.2 1.2v9.2q0 1.2-1.2 1.2H2q-1.2 0-1.2-1.2V3.4q0-1.2 1.2-1.2zM2.1 3.5v9h11.8v-9zM3.3 12.4q2-5 4.3-5q2.3 0 4.3 5z'
  },
  // A rounded screen with a swept prompt chevron and its command line.
  terminal: {
    accentColor: 'var(--cth-mint)',
    ink: 'M2.6 2.2h10.8q1.6 0 1.6 1.6v8.4q0 1.6-1.6 1.6H2.6q-1.6 0-1.6-1.6V3.8q0-1.6 1.6-1.6zM2.6 3.5q-0.3 0-0.3 0.3v8.4q0 0.3 0.3 0.3h10.8q0.3 0 0.3-0.3V3.8q0-0.3-0.3-0.3zM4.6 5.6q0.5-0.5 1 0L8 8q0.4 0.4 0 0.9l-2.4 2.4q-0.5 0.5-1 0q-0.5-0.5 0-1L6.6 8.4 4.6 6.6q-0.5-0.5 0-1zM8.8 10.2h3.2q0.5 0 0.5 0.6q0 0.6-0.5 0.6H8.8q-0.5 0-0.5-0.6q0-0.6 0.5-0.6z'
  },
  // The two chevrons, each one continuous stroke with rounded joins.
  code: {
    accentColor: 'var(--cth-sky)',
    ink: 'M5.6 3.8q0.6-0.6 1.2 0q0.6 0.6 0 1.2L3.9 8l2.9 3q0.6 0.6 0 1.2q-0.6 0.6-1.2 0L2.1 8.6q-0.5-0.6 0-1.2zM10.4 3.8q-0.6-0.6-1.2 0q-0.6 0.6 0 1.2L12.1 8l-2.9 3q-0.6 0.6 0 1.2q0.6 0.6 1.2 0l3.5-3.6q0.5-0.6 0-1.2z'
  },
  // A globe as two rings and a rule: the outer sphere, the meridian, and an
  // equator kept short enough to stay inside the sphere's hole, so it does not
  // cut a gap through the rim where the two would otherwise cross.
  web: {
    accentColor: 'var(--cth-sky)',
    ink: 'M8 1a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM8 2.3a5.7 5.7 0 1 1 0 11.4a5.7 5.7 0 1 1 0-11.4zM8 1q2.6 3 2.6 7q0 4-2.6 7q-2.6-3-2.6-7q0-4 2.6-7zM8 2.3q-1.3 2.4-1.3 5.7q0 3.3 1.3 5.7q1.3-2.4 1.3-5.7q0-3.3-1.3-5.7zM2.6 7.3h10.8v1.4H2.6z'
  },
  // Two open rings holding a bar between them — a coupling. The protocol is a
  // thing that joins two halves, and a chain-link says that at 16px where a
  // socket does not.
  mcp: {
    accentColor: 'var(--cth-lilac)',
    ink: 'M5.4 4.2a3.8 3.8 0 1 0 0 7.6h1.4v-1.4H5.4a2.4 2.4 0 1 1 0-4.8h1.4V4.2zM10.6 4.2H9.2v1.4h1.4a2.4 2.4 0 1 1 0 4.8H9.2v1.4h1.4a3.8 3.8 0 1 0 0-7.6zM5.8 7.3h4.4v1.4H5.8z'
  },
  // A four-pointed star with concave flanks — the deco convention for a
  // gleam — with a second, smaller one struck off it as the accent.
  sparkle: {
    accentColor: 'var(--cth-lemon)',
    accent: 'M12.8 10.2q0.25 1.6 0.65 2q0.4 0.4 2 0.65q-1.6 0.25-2 0.65q-0.4 0.4-0.65 2q-0.25-1.6-0.65-2q-0.4-0.4-2-0.65q1.6-0.25 2-0.65q0.4-0.4 0.65-2z',
    ink: 'M8 0.8q0.6 4.2 1.6 5.3q1 1.1 5.6 1.9q-4.6 0.8-5.6 1.9q-1 1.1-1.6 5.3q-0.6-4.2-1.6-5.3q-1-1.1-5.6-1.9q4.6-0.8 5.6-1.9q1-1.1 1.6-5.3z'
  },
  // Four arrows swept out to the corners, each a rounded stroke and a bracket.
  expand: {
    accentColor: 'var(--cth-sky)',
    ink: 'M1.4 1.4h4.4q0.8 0 0.8 0.8q0 0.8-0.8 0.8H4.1l2.4 2.4q0.6 0.6 0 1.2q-0.6 0.6-1.2 0L2.9 4.2v1.7q0 0.8-0.8 0.8q-0.8 0-0.8-0.8zM14.6 1.4v4.4q0 0.8-0.8 0.8q-0.8 0-0.8-0.8V4.2l-2.4 2.4q-0.6 0.6-1.2 0q-0.6-0.6 0-1.2l2.4-2.4h-1.7q-0.8 0-0.8-0.8q0-0.8 0.8-0.8zM1.4 14.6v-4.4q0-0.8 0.8-0.8q0.8 0 0.8 0.8v1.7l2.4-2.4q0.6-0.6 1.2 0q0.6 0.6 0 1.2l-2.4 2.4h1.7q0.8 0 0.8 0.8q0 0.8-0.8 0.8zM14.6 14.6h-4.4q-0.8 0-0.8-0.8q0-0.8 0.8-0.8h1.7l-2.4-2.4q-0.6-0.6 0-1.2q0.6-0.6 1.2 0l2.4 2.4v-1.7q0-0.8 0.8-0.8q0.8 0 0.8 0.8z'
  },
  // The same four arrows turned inward. Kept deliberately distinct from
  // `sidebar`, which sits in the same toolbar — see the pixel set's note.
  minimize: {
    accentColor: 'var(--cth-sky)',
    ink: 'M6.2 1.6q0.8 0 0.8 0.8v4.4q0 0.8-0.8 0.8H1.8q-0.8 0-0.8-0.8q0-0.8 0.8-0.8h2.3L1.7 3.5q-0.6-0.6 0-1.2q0.6-0.6 1.2 0l2.5 2.5V2.4q0-0.8 0.8-0.8zM9.8 1.6q0.8 0 0.8 0.8v2.4l2.5-2.5q0.6-0.6 1.2 0q0.6 0.6 0 1.2l-2.4 2.5h2.3q0.8 0 0.8 0.8q0 0.8-0.8 0.8H9.8q-0.8 0-0.8-0.8V2.4q0-0.8 0.8-0.8zM1.8 9h4.4q0.8 0 0.8 0.8v4.4q0 0.8-0.8 0.8q-0.8 0-0.8-0.8v-2.3l-2.5 2.5q-0.6 0.6-1.2 0q-0.6-0.6 0-1.2l2.5-2.5H1.8q-0.8 0-0.8-0.8q0-0.8 0.8-0.8zM9.8 9h4.4q0.8 0 0.8 0.8q0 0.8-0.8 0.8h-2.3l2.5 2.5q0.6 0.6 0 1.2q-0.6 0.6-1.2 0l-2.5-2.5v2.3q0 0.8-0.8 0.8q-0.8 0-0.8-0.8V9.8q0-0.8 0.8-0.8z'
  },
  // A ring with the hands as one tapered stroke from the centre — still at five
  // o'clock, still closing time.
  clock: {
    accentColor: 'var(--cth-lemon)',
    ink: 'M8 1a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM8 2.4a5.6 5.6 0 1 1 0 11.2a5.6 5.6 0 1 1 0-11.2zM7.3 4.3q0-0.7 0.7-0.7q0.7 0 0.7 0.7v3.5l2.4 1.9q0.6 0.5 0.1 1.1q-0.5 0.6-1.1 0.1L7.6 8.6q-0.3-0.3-0.3-0.7z'
  },
  // A capsule head above an open cradle, the stem and foot drawn as one stroke.
  mic: {
    accentColor: 'var(--cth-coral)',
    ink: 'M8 1.4q2 0 2 2v3.9q0 2-2 2q-2 0-2-2V3.4q0-2 2-2zM4.3 7q0.7 0 0.7 0.7q0 3 3 3q3 0 3-3q0-0.7 0.7-0.7q0.7 0 0.7 0.7q0 3.6-3.7 4.3v1.2h1.6q0.7 0 0.7 0.7q0 0.7-0.7 0.7H6.7q-0.7 0-0.7-0.7q0-0.7 0.7-0.7h1.6v-1.2Q3.6 11.3 3.6 7.7q0-0.7 0.7-0.7z'
  },
  // A page with its top-right corner turned, ruled with three written lines —
  // the last one short, as a part-filled entry is.
  ledger: {
    accentColor: 'var(--cth-lemon)',
    ink: 'M2.8 1.2h7.5q0.4 0 0.7 0.3l2.7 2.7q0.3 0.3 0.3 0.7v9.9q0 1-1 1H2.8q-1 0-1-1V2.2q0-1 1-1zM3.2 2.6v10.8h9.6V5.4h-2q-0.7 0-0.7-0.7V2.6zM5.2 6.4h5.6q0.5 0 0.5 0.6q0 0.6-0.5 0.6H5.2q-0.5 0-0.5-0.6q0-0.6 0.5-0.6zM5.2 8.9h5.6q0.5 0 0.5 0.6q0 0.6-0.5 0.6H5.2q-0.5 0-0.5-0.6q0-0.6 0.5-0.6zM5.2 11.4h3.4q0.5 0 0.5 0.6q0 0.6-0.5 0.6H5.2q-0.5 0-0.5-0.6q0-0.6 0.5-0.6z'
  },
  // A solid disc with the 'i' knocked out of it, keeping the pixel set's own
  // reasoning: a knocked-out glyph stays legible at 16px where an outline
  // would shimmer.
  info: {
    accentColor: 'var(--cth-sky)',
    ink: 'M8 1a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM8 3.6a1.15 1.15 0 1 1 0 2.3a1.15 1.15 0 1 1 0-2.3zM7 7.2h2q0.4 0 0.4 0.5v4.6q0 0.5-0.4 0.5H7q-0.4 0-0.4-0.5V7.7q0-0.5 0.4-0.5z'
  },
  // Panel outline with the left column filled back in — three subpaths under
  // evenodd, exactly as the pixel version, softened at the corners.
  sidebar: {
    accentColor: 'var(--cth-ink-300)',
    ink: 'M2.4 2.6h11.2q1.4 0 1.4 1.4v8q0 1.4-1.4 1.4H2.4q-1.4 0-1.4-1.4V4q0-1.4 1.4-1.4zM2.4 3.9q-0.1 0-0.1 0.1v8q0 0.1 0.1 0.1h11.2q0.1 0 0.1-0.1V4q0-0.1-0.1-0.1zM2.3 3.9h3.9v8.2H2.3z'
  },
  // Three ringed nodes and the branch curving between them: a commit graph,
  // which is the one thing about git that draws.
  git: {
    accentColor: 'var(--cth-coral)',
    ink: 'M4 1a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2zM4 2.4a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4zM4 9.8a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2zM4 11.2a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4zM12 4.4a2.6 2.6 0 1 0 0 5.2a2.6 2.6 0 1 0 0-5.2zM12 5.8a1.2 1.2 0 1 1 0 2.4a1.2 1.2 0 1 1 0-2.4zM3.3 6.2h1.4v3.6H3.3zM5 5.4q3.4 0.2 4.4 1.6q0.3 0.5-0.2 0.9q-0.5 0.3-0.9-0.2q-0.7-1-3.3-1.2z'
  }
};
