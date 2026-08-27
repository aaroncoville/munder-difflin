/**
 * The face on an assistant, wherever the chrome draws one.
 *
 * Two casts share one slot. The pixel sprites are the office's own people and
 * belong to the light and dark themes; the painted pack belongs to the Study,
 * which replaced the office floor under the occult theme. The strip along the
 * foot of the window kept drawing recolored sprites regardless, so the same
 * assistant appeared twice with two different faces, one above the other.
 *
 * Which face a painted assistant wears is not decided here: `portraitFor` owns
 * that rule — named for a face wears it, anyone else is dealt one from their
 * id, and the orchestrator's face is reserved — and the floor already calls it.
 * Routing both surfaces through one component is what keeps them agreeing; two
 * call sites picking a portrait each is how they drifted apart in the first
 * place.
 *
 * A theme with no painted pack, or an assistant the pack cannot cover, falls
 * back to the sprite rather than to nothing.
 */
import { useAppTheme } from '@/design/theme';
import { OfficeCharacterName } from '@/scene/office/cast';
import { portraitFor } from '@/scene/study/portraits';
import { SpritePortrait } from './SpritePortrait';

export interface AgentFaceProps {
  /** The assistant's id — what a face is dealt from when the name matches none. */
  id: string;
  name: string;
  /** The pixel cast member to draw under light and dark. */
  character: OfficeCharacterName;
  /** Pixels per source pixel, passed straight to the sprite. Ignored by the
   *  painted portrait, which fills whatever tile it is given. */
  scale?: number;
  isGod?: boolean;
}

export function AgentFace({ id, name, character, scale = 2, isGod }: AgentFaceProps) {
  const theme = useAppTheme();
  const painted = theme === 'occult' ? portraitFor({ id, name, isGod }) : undefined;
  if (!painted) return <SpritePortrait character={character} scale={scale} />;
  return (
    <img
      src={painted}
      alt=""
      aria-hidden
      draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'cover', userSelect: 'none' }}
    />
  );
}
