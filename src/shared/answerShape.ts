/** The shape of an answer to an ask, so a review can tell one-tap answers from real decisions
 *  without keeping the answer text. Shared by the main process and the renderer. */
export type AnswerShape = 'done-ack' | 'option' | 'short' | 'sentence' | 'long';

export function answerShape(answer: string): AnswerShape {
  const a = answer.trim().toLowerCase().replace(/[.!]+$/, '');
  if (['done', 'ack', 'ok', 'okay', 'yes', 'no', 'go', 'superseded', 'merged'].includes(a)) return 'done-ack';
  if (/^[a-z0-9]$/.test(a)) return 'option';
  if (a.length <= 20) return 'short';
  if (a.length <= 280) return 'sentence';
  return 'long';
}
