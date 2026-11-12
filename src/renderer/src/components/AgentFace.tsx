/**
 * The face on an assistant, wherever the chrome draws one.
 *
 * Assistants wear the Study's painted pack. The strip along the foot of the
 * window once drew recolored pixel sprites while the floor above it drew
 * portraits, so the same assistant appeared twice with two different faces,
 * one above the other.
 *
 * Which face a painted assistant wears is not decided here: `portraitFor` owns
 * that rule — named for a face wears it, anyone else is dealt one from their
 * id, and the orchestrator's face is reserved — and the floor already calls it.
 * Routing both surfaces through one component is what keeps them agreeing; two
 * call sites picking a portrait each is how they drifted apart in the first
 * place.
 *
 * An assistant the pack cannot cover falls back to a monogram rather than to
 * nothing — the same one, in the same face, as the Study's unillustrated card.
 */
import { portraitFor } from '@/scene/study/portraits';
import { monogramFor } from '@/scene/study/AgentCard';

export interface AgentFaceProps {
  /** The assistant's id — what a face is dealt from when the name matches none. */
  id: string;
  name: string;
  isGod?: boolean;
}

export function AgentFace({ id, name, isGod }: AgentFaceProps) {
  const painted = portraitFor({ id, name, isGod });
  if (!painted) {
    return (
      <div
        aria-hidden
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--cth-font-display)',
          fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-gilt)',
          userSelect: 'none'
        }}
      >
        {monogramFor(name)}
      </div>
    );
  }
  return (
    <img
      src={painted}
      alt=""
      aria-hidden
      draggable={false}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        userSelect: 'none'
      }}
    />
  );
}
