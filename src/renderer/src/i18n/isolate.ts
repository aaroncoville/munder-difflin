/**
 * `text` between the Unicode isolate marks FSI (U+2068) and PDI (U+2069): the plain-text form of <bdi>. A part of a
 * sentence that keeps its own direction, such as an English error or card title inside an Arabic sentence, is
 * isolated this way where the sentence is built as a single string, so it is laid out in its own order.
 */
export const isolate = (text: string): string => `\u2068${text}\u2069`;
