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
 * An assistant the pack cannot cover falls back to the sprite rather than to
 * nothing.
 */
import { OfficeCharacterName } from '@/scene/office/cast';
import { portraitFor } from '@/scene/study/portraits';
import { SpritePortrait } from './SpritePortrait';

export interface AgentFaceProps {
  /** The assistant's id — what a face is dealt from when the name matches none. */
  id: string;
  name: string;
  /** The pixel cast member to draw when no portrait can be dealt. */
  character: OfficeCharacterName;
  /** Pixels per source pixel, passed straight to the sprite. Ignored by the
   *  painted portrait, which fills whatever tile it is given. */
  scale?: number;
  isGod?: boolean;
}

export function AgentFace({ id, name, character, scale = 2, isGod }: AgentFaceProps) {
  const painted = portraitFor({ id, name, isGod });
  if (!painted) return <SpritePortrait character={character} scale={scale} />;
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
