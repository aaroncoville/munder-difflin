/**
 * The wall of painted faces you summon an assistant from.
 *
 * Under the office themes the same control is a row of pixel cast members, and
 * clicking one names the agent after that character. This is that interaction
 * in the Study's idiom: the cast is the licensed portrait pack, and choosing a
 * face hands back the portrait's own NAME rather than a file or an index.
 *
 * The name is the payload on purpose. `scene/study/portraits.ts` assigns a face
 * by name first and by hashed id second, so naming the assistant after the
 * portrait is the entire mechanism by which the assistant then wears it. A
 * picker that returned a URL would have to invent a second, parallel rule.
 *
 * The orchestrator's own face is not on the wall: it is reserved, and the
 * orchestrator is not somebody you summon.
 */
import { PORTRAIT_FILES, PORTRAIT_NAMES, GOD_PORTRAIT } from '@/scene/study/portraits';

export interface PortraitPickerProps {
  /** The portrait's name, or undefined when nothing has been chosen yet. */
  selected: string | undefined;
  onPick: (name: string) => void;
}

/** The pack in index order, minus the reserved face. */
const OFFERED = PORTRAIT_NAMES
  .map((name, i) => ({ name, src: PORTRAIT_FILES[i] }))
  .filter((p) => p.name !== GOD_PORTRAIT);

export function PortraitPicker({ selected, onPick }: PortraitPickerProps): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(56px, 1fr))',
        gap: 6,
        // The pack is fifty faces deep; the summoning screen is not. It scrolls
        // rather than pushing the rest of the form off the dialog.
        maxHeight: 208,
        overflowY: 'auto',
        padding: 2
      }}
    >
      {OFFERED.map((p) => {
        const chosen = p.name === selected;
        return (
          <button
            key={p.name}
            data-portrait={p.name}
            aria-pressed={chosen}
            title={p.name}
            onClick={() => onPick(p.name)}
            style={{
              padding: 3,
              background: chosen ? 'var(--cth-cream-200)' : 'var(--cth-cream-100)',
              boxShadow: chosen
                ? 'inset 0 0 0 1.5px var(--cth-gilt)'
                : 'inset 0 0 0 1px var(--cth-ink-100)',
              cursor: 'pointer',
              border: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2
            }}
          >
            <img
              src={p.src}
              /* The name below is the label; the picture repeats it. */
              alt=""
              style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', display: 'block' }}
            />
            <span
              style={{
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 10,
                lineHeight: 1.2,
                color: chosen ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '100%'
              }}
            >
              {p.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
