/** Card ids: a short id token, never free text. */
const CARD_ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;

/**
 * The key an ask is logged under, on the floor side and the owner's side alike:
 * `<cardId>@<askedAt as canonical ISO>`. The weekly digest pairs rows by it, so
 * both sides must build it here. undefined when either part is not valid.
 */
export function askKeyOf(cardId: unknown, askedAt: unknown): string | undefined {
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId)) return undefined;
  const t = typeof askedAt === 'string' ? Date.parse(askedAt) : NaN;
  return Number.isFinite(t) ? `${cardId}@${new Date(t).toISOString()}` : undefined;
}
