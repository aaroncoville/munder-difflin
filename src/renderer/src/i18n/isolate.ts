/**
 * `text` between the Unicode isolate marks FSI (U+2068) and PDI (U+2069): the plain-text form of <bdi>. A part of a
 * sentence that keeps its own direction, such as an English error or card title inside an Arabic sentence, is
 * isolated this way where the sentence is built as a single string, so it is laid out in its own order. Isolate marks
 * already in `text` (U+2066 to U+2069) are dropped first, so it cannot close the isolation early.
 */
export const isolate = (text: string): string => `\u2068${text.replace(/[\u2066-\u2069]/g, '')}\u2069`;
