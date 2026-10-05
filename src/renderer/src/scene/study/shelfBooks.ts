/**
 * What the shelf wall holds, and where on it each thing sits.
 *
 * Aaron's design: the shelves room is a painting of pale books, and an archived
 * thing lights one of them up — by DARKENING it. Against light books, darkening
 * is what reads as emphasis, so the whole vocabulary here is inverted from the
 * usual and the code says `darken` on purpose.
 *
 * What the wall keeps is the House's FINISHED WORK. It kept departed assistants
 * instead, until Aaron read the darkening books as "where the done items go" —
 * which is the better reading, because a departed assistant has already left
 * the floor while a concluded commission has nowhere else to be once the card
 * table carries open work only. The geometry below still describes any dated or
 * undated thing, because the bound is about the wall's capacity rather than
 * about what is standing on it.
 *
 * ── The bound, and why it is the shape it is ───────────────────────────────
 *
 * A wall that keeps everything looks right on the day it ships and is an
 * unreadable smear a month later, so it is bounded two ways: an age window and
 * a hard count, oldest off first.
 *
 * The age window can only be applied to something that HAS an age, and the
 * ledger is a file edited by hand: a card can reach this wall with every one of
 * its timestamps missing or unreadable. Dropping the undated for want of a date
 * would mean finished work VANISHING rather than being archived, which is the
 * opposite of what the wall is for. So the window filters what has a date, the
 * count bounds everything, and the undated keep the order the ledger gives them
 * — which is file order, and therefore a real ordering even without a clock.
 *
 * ── Why this file is not called shelfArchive.ts ────────────────────────────
 *
 * It was, next to the `ShelfArchive.tsx` that draws these. On a
 * case-insensitive filesystem — every default macOS and Windows checkout —
 * `./ShelfArchive` and `./shelfArchive` are the same path, and a resolver that
 * tries `.ts` before `.tsx` hands the importer THIS module when it asked for the
 * component. The component then resolves to undefined and renders as nothing,
 * with no error anywhere; on Linux the same code is fine, so it is the kind of
 * bug that only appears on somebody else's machine. Two modules whose names
 * differ only in case are a trap regardless of who resolves them first.
 */

/**
 * Where each volume the wall can mark stands, normalized to the shelves panel.
 *
 * These are the painted books themselves. Aaron: *"the library books being
 * archived don't even line up with the background books on the shelves — I was
 * thinking you'd have the same image but with pieces darker that you could
 * activate in that layer, so the actual background comes alive."* So nothing is
 * drawn: archiving darkens the painting inside one of these rectangles, and the
 * thing that stands out is paint the painter put there.
 *
 * Each rectangle is one painted SPINE, and one finished commission darkens
 * exactly one of them. The wall had been cut into bays — the run of books
 * between two posts on one shelf — so that fifty-odd marks could fill it, but a
 * bay is a chunk of several books standing for one piece of work, and the wall
 * could then only ever say "about this much". A spine per commission keeps both
 * readings: a full wall is still a wall that has filled, and every darkened
 * book on it is one thing that was finished.
 *
 * The spines stop short of the three things on the wall that are not books. A
 * lamp is what lights the wall, and a shade taken down with the books beside it
 * reads as the light going out; the ladder and the sleeping cat stand in front
 * of the shelves rather than on them. A volume behind one of those is not
 * offered at all.
 *
 * The order is the order they are handed out in — along each shelf, top shelf
 * first — which is how a wall of books fills, so the archive reads as a level.
 *
 * Read off the painting rather than authored freehand. Within each run of books
 * between two posts, a spine's sides are where the colour of the paint changes
 * from one column to the next — the painted titles are left out of that, since
 * a glyph is an edge inside a book rather than between two — and a run too wide
 * to be one volume is split at its strongest remaining edge. A spine's top is
 * the first row, going down, below which the paint is that book's own colour.
 * Every spine stands on its ledge, so the bottoms of one shelf's spines agree
 * where their tops do not.
 */
export const SHELF_BOOKS: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 0.0108, y: 0.0268, w: 0.0141, h: 0.1175 },
  { x: 0.0249, y: 0.0268, w: 0.0076, h: 0.1175 },
  { x: 0.0325, y: 0.0283, w: 0.0141, h: 0.1160 },
  { x: 0.0466, y: 0.0432, w: 0.0185, h: 0.1011 },
  { x: 0.0651, y: 0.0179, w: 0.0197, h: 0.1264 },
  { x: 0.0848, y: 0.0074, w: 0.0128, h: 0.1369 },
  { x: 0.1084, y: 0.0446, w: 0.0134, h: 0.0997 },
  { x: 0.1218, y: 0.0432, w: 0.0115, h: 0.1011 },
  { x: 0.1333, y: 0.0417, w: 0.0121, h: 0.1026 },
  { x: 0.1454, y: 0.0461, w: 0.0083, h: 0.0982 },
  { x: 0.1537, y: 0.0313, w: 0.0185, h: 0.1130 },
  { x: 0.1722, y: 0.0446, w: 0.0064, h: 0.0997 },
  { x: 0.1786, y: 0.0357, w: 0.0185, h: 0.1086 },
  { x: 0.1971, y: 0.0253, w: 0.0083, h: 0.1190 },
  { x: 0.2353, y: 0.0476, w: 0.0058, h: 0.0967 },
  { x: 0.2411, y: 0.0298, w: 0.0115, h: 0.1145 },
  { x: 0.2526, y: 0.0313, w: 0.0082, h: 0.1130 },
  { x: 0.2608, y: 0.0313, w: 0.0058, h: 0.1130 },
  { x: 0.2666, y: 0.0476, w: 0.0210, h: 0.0967 },
  { x: 0.2876, y: 0.0193, w: 0.0058, h: 0.1250 },
  { x: 0.2934, y: 0.0179, w: 0.0172, h: 0.1264 },
  { x: 0.3106, y: 0.0461, w: 0.0108, h: 0.0982 },
  { x: 0.3214, y: 0.0357, w: 0.0115, h: 0.1086 },
  { x: 0.3329, y: 0.0357, w: 0.0128, h: 0.1086 },
  { x: 0.3457, y: 0.0446, w: 0.0134, h: 0.0997 },
  { x: 0.3591, y: 0.0476, w: 0.0178, h: 0.0967 },
  { x: 0.3769, y: 0.0253, w: 0.0166, h: 0.1190 },
  { x: 0.4043, y: 0.0476, w: 0.0102, h: 0.0967 },
  { x: 0.4145, y: 0.0432, w: 0.0147, h: 0.1011 },
  { x: 0.4292, y: 0.0461, w: 0.0166, h: 0.0982 },
  { x: 0.4458, y: 0.0476, w: 0.0236, h: 0.0967 },
  { x: 0.4694, y: 0.0283, w: 0.0159, h: 0.1160 },
  { x: 0.4853, y: 0.0283, w: 0.0064, h: 0.1160 },
  { x: 0.5096, y: 0.0446, w: 0.0089, h: 0.0997 },
  { x: 0.5185, y: 0.0446, w: 0.0108, h: 0.0997 },
  { x: 0.5293, y: 0.0298, w: 0.0058, h: 0.1145 },
  { x: 0.5351, y: 0.0461, w: 0.0178, h: 0.0982 },
  { x: 0.5529, y: 0.0313, w: 0.0192, h: 0.1130 },
  { x: 0.5721, y: 0.0446, w: 0.0108, h: 0.0997 },
  { x: 0.5829, y: 0.0417, w: 0.0134, h: 0.1026 },
  { x: 0.6078, y: 0.0268, w: 0.0191, h: 0.1175 },
  { x: 0.6269, y: 0.0372, w: 0.0058, h: 0.1071 },
  { x: 0.6327, y: 0.0372, w: 0.0165, h: 0.1071 },
  { x: 0.6492, y: 0.0461, w: 0.0090, h: 0.0982 },
  { x: 0.6582, y: 0.0074, w: 0.0076, h: 0.1369 },
  { x: 0.6658, y: 0.0313, w: 0.0121, h: 0.1130 },
  { x: 0.6779, y: 0.0357, w: 0.0122, h: 0.1086 },
  { x: 0.6901, y: 0.0298, w: 0.0140, h: 0.1145 },
  { x: 0.7156, y: 0.0357, w: 0.0095, h: 0.1086 },
  { x: 0.7251, y: 0.0476, w: 0.0109, h: 0.0967 },
  { x: 0.7360, y: 0.0283, w: 0.0057, h: 0.1160 },
  { x: 0.7417, y: 0.0298, w: 0.0102, h: 0.1145 },
  { x: 0.7519, y: 0.0461, w: 0.0147, h: 0.0982 },
  { x: 0.7666, y: 0.0283, w: 0.0153, h: 0.1160 },
  { x: 0.7819, y: 0.0461, w: 0.0229, h: 0.0982 },
  { x: 0.8170, y: 0.0238, w: 0.0095, h: 0.1205 },
  { x: 0.8265, y: 0.0446, w: 0.0102, h: 0.0997 },
  { x: 0.8367, y: 0.0417, w: 0.0160, h: 0.1026 },
  { x: 0.8527, y: 0.0417, w: 0.0108, h: 0.1026 },
  { x: 0.8635, y: 0.0417, w: 0.0128, h: 0.1026 },
  { x: 0.8763, y: 0.0565, w: 0.0127, h: 0.0878 },
  { x: 0.8890, y: 0.0446, w: 0.0141, h: 0.0997 },
  { x: 0.9133, y: 0.0372, w: 0.0114, h: 0.1071 },
  { x: 0.9247, y: 0.0298, w: 0.0122, h: 0.1145 },
  { x: 0.9369, y: 0.0536, w: 0.0095, h: 0.0907 },
  { x: 0.9464, y: 0.0074, w: 0.0141, h: 0.1369 },
  { x: 0.9605, y: 0.0461, w: 0.0114, h: 0.0982 },
  { x: 0.9719, y: 0.0461, w: 0.0102, h: 0.0982 },
  { x: 0.9821, y: 0.0446, w: 0.0173, h: 0.0997 },
  { x: 0.0344, y: 0.1905, w: 0.0173, h: 0.1131 },
  { x: 0.0517, y: 0.1905, w: 0.0089, h: 0.1131 },
  { x: 0.0606, y: 0.1979, w: 0.0166, h: 0.1057 },
  { x: 0.0772, y: 0.2024, w: 0.0063, h: 0.1012 },
  { x: 0.0835, y: 0.1905, w: 0.0141, h: 0.1131 },
  { x: 0.1084, y: 0.1949, w: 0.0134, h: 0.1087 },
  { x: 0.1218, y: 0.2024, w: 0.0109, h: 0.1012 },
  { x: 0.1327, y: 0.1920, w: 0.0146, h: 0.1116 },
  { x: 0.1473, y: 0.1935, w: 0.0134, h: 0.1101 },
  { x: 0.1607, y: 0.2068, w: 0.0128, h: 0.0968 },
  { x: 0.1735, y: 0.2188, w: 0.0095, h: 0.0848 },
  { x: 0.1830, y: 0.1905, w: 0.0122, h: 0.1131 },
  { x: 0.2481, y: 0.2277, w: 0.0096, h: 0.0759 },
  { x: 0.2577, y: 0.1905, w: 0.0076, h: 0.1131 },
  { x: 0.2653, y: 0.2083, w: 0.0077, h: 0.0953 },
  { x: 0.2730, y: 0.2083, w: 0.0063, h: 0.0953 },
  { x: 0.2793, y: 0.2202, w: 0.0102, h: 0.0834 },
  { x: 0.2895, y: 0.1905, w: 0.0128, h: 0.1131 },
  { x: 0.3023, y: 0.1905, w: 0.0096, h: 0.1131 },
  { x: 0.3119, y: 0.1979, w: 0.0172, h: 0.1057 },
  { x: 0.3291, y: 0.2068, w: 0.0147, h: 0.0968 },
  { x: 0.3438, y: 0.2068, w: 0.0095, h: 0.0968 },
  { x: 0.3533, y: 0.1964, w: 0.0140, h: 0.1072 },
  { x: 0.3673, y: 0.2009, w: 0.0103, h: 0.1027 },
  { x: 0.3776, y: 0.1905, w: 0.0076, h: 0.1131 },
  { x: 0.3852, y: 0.1905, w: 0.0083, h: 0.1131 },
  { x: 0.4043, y: 0.1905, w: 0.0166, h: 0.1131 },
  { x: 0.4209, y: 0.1920, w: 0.0109, h: 0.1116 },
  { x: 0.4318, y: 0.1905, w: 0.0127, h: 0.1131 },
  { x: 0.4445, y: 0.2039, w: 0.0096, h: 0.0997 },
  { x: 0.4541, y: 0.1905, w: 0.0108, h: 0.1131 },
  { x: 0.4649, y: 0.2262, w: 0.0141, h: 0.0774 },
  { x: 0.5287, y: 0.1905, w: 0.0179, h: 0.1131 },
  { x: 0.5466, y: 0.1920, w: 0.0121, h: 0.1116 },
  { x: 0.5587, y: 0.1905, w: 0.0127, h: 0.1131 },
  { x: 0.5714, y: 0.1994, w: 0.0141, h: 0.1042 },
  { x: 0.5855, y: 0.1905, w: 0.0108, h: 0.1131 },
  { x: 0.6078, y: 0.1979, w: 0.0102, h: 0.1057 },
  { x: 0.6180, y: 0.2068, w: 0.0089, h: 0.0968 },
  { x: 0.6269, y: 0.1905, w: 0.0223, h: 0.1131 },
  { x: 0.6492, y: 0.1920, w: 0.0115, h: 0.1116 },
  { x: 0.6607, y: 0.1905, w: 0.0121, h: 0.1131 },
  { x: 0.6728, y: 0.1905, w: 0.0058, h: 0.1131 },
  { x: 0.7302, y: 0.1905, w: 0.0102, h: 0.1131 },
  { x: 0.7404, y: 0.2202, w: 0.0141, h: 0.0834 },
  { x: 0.7545, y: 0.1905, w: 0.0108, h: 0.1131 },
  { x: 0.7653, y: 0.2009, w: 0.0121, h: 0.1027 },
  { x: 0.7774, y: 0.2068, w: 0.0115, h: 0.0968 },
  { x: 0.7889, y: 0.1905, w: 0.0159, h: 0.1131 },
  { x: 0.8170, y: 0.2009, w: 0.0063, h: 0.1027 },
  { x: 0.8233, y: 0.1905, w: 0.0147, h: 0.1131 },
  { x: 0.8380, y: 0.2083, w: 0.0058, h: 0.0953 },
  { x: 0.8438, y: 0.1935, w: 0.0057, h: 0.1101 },
  { x: 0.8495, y: 0.1905, w: 0.0096, h: 0.1131 },
  { x: 0.8591, y: 0.2143, w: 0.0070, h: 0.0893 },
  { x: 0.8661, y: 0.1905, w: 0.0057, h: 0.1131 },
  { x: 0.8718, y: 0.1905, w: 0.0077, h: 0.1131 },
  { x: 0.9426, y: 0.1905, w: 0.0140, h: 0.1131 },
  { x: 0.9566, y: 0.2158, w: 0.0102, h: 0.0878 },
  { x: 0.9668, y: 0.2009, w: 0.0058, h: 0.1027 },
  { x: 0.9726, y: 0.1949, w: 0.0095, h: 0.1087 },
  { x: 0.9821, y: 0.1905, w: 0.0173, h: 0.1131 },
  { x: 0.0344, y: 0.3557, w: 0.0090, h: 0.1086 },
  { x: 0.0434, y: 0.3824, w: 0.0102, h: 0.0819 },
  { x: 0.0536, y: 0.3676, w: 0.0102, h: 0.0967 },
  { x: 0.0638, y: 0.3557, w: 0.0102, h: 0.1086 },
  { x: 0.0740, y: 0.3557, w: 0.0121, h: 0.1086 },
  { x: 0.0861, y: 0.3631, w: 0.0115, h: 0.1012 },
  { x: 0.1084, y: 0.3661, w: 0.0077, h: 0.0982 },
  { x: 0.1161, y: 0.3661, w: 0.0115, h: 0.0982 },
  { x: 0.1276, y: 0.3557, w: 0.0204, h: 0.1086 },
  { x: 0.1480, y: 0.3631, w: 0.0095, h: 0.1012 },
  { x: 0.1575, y: 0.3780, w: 0.0198, h: 0.0863 },
  { x: 0.1773, y: 0.3557, w: 0.0179, h: 0.1086 },
  { x: 0.2481, y: 0.3557, w: 0.0147, h: 0.1086 },
  { x: 0.2628, y: 0.3780, w: 0.0153, h: 0.0863 },
  { x: 0.2781, y: 0.3824, w: 0.0102, h: 0.0819 },
  { x: 0.2883, y: 0.3557, w: 0.0210, h: 0.1086 },
  { x: 0.3093, y: 0.3571, w: 0.0115, h: 0.1072 },
  { x: 0.3208, y: 0.3958, w: 0.0159, h: 0.0685 },
  { x: 0.3367, y: 0.3557, w: 0.0160, h: 0.1086 },
  { x: 0.3527, y: 0.3557, w: 0.0076, h: 0.1086 },
  { x: 0.3603, y: 0.3705, w: 0.0166, h: 0.0938 },
  { x: 0.3769, y: 0.3557, w: 0.0166, h: 0.1086 },
  { x: 0.4043, y: 0.3646, w: 0.0211, h: 0.0997 },
  { x: 0.4254, y: 0.3557, w: 0.0121, h: 0.1086 },
  { x: 0.4375, y: 0.3557, w: 0.0102, h: 0.1086 },
  { x: 0.4477, y: 0.3810, w: 0.0134, h: 0.0833 },
  { x: 0.4611, y: 0.3557, w: 0.0179, h: 0.1086 },
  { x: 0.5287, y: 0.3557, w: 0.0102, h: 0.1086 },
  { x: 0.5389, y: 0.3557, w: 0.0108, h: 0.1086 },
  { x: 0.5497, y: 0.3795, w: 0.0096, h: 0.0848 },
  { x: 0.5593, y: 0.3631, w: 0.0121, h: 0.1012 },
  { x: 0.5714, y: 0.3824, w: 0.0115, h: 0.0819 },
  { x: 0.5829, y: 0.3958, w: 0.0134, h: 0.0685 },
  { x: 0.6078, y: 0.3586, w: 0.0121, h: 0.1057 },
  { x: 0.6199, y: 0.3631, w: 0.0217, h: 0.1012 },
  { x: 0.6416, y: 0.3854, w: 0.0095, h: 0.0789 },
  { x: 0.6511, y: 0.3557, w: 0.0115, h: 0.1086 },
  { x: 0.6626, y: 0.3824, w: 0.0083, h: 0.0819 },
  { x: 0.6709, y: 0.3557, w: 0.0077, h: 0.1086 },
  { x: 0.7302, y: 0.3557, w: 0.0064, h: 0.1086 },
  { x: 0.7366, y: 0.3795, w: 0.0236, h: 0.0848 },
  { x: 0.7602, y: 0.3557, w: 0.0083, h: 0.1086 },
  { x: 0.7685, y: 0.3557, w: 0.0159, h: 0.1086 },
  { x: 0.7844, y: 0.3661, w: 0.0109, h: 0.0982 },
  { x: 0.7953, y: 0.3795, w: 0.0095, h: 0.0848 },
  { x: 0.8170, y: 0.3571, w: 0.0108, h: 0.1072 },
  { x: 0.8278, y: 0.3795, w: 0.0147, h: 0.0848 },
  { x: 0.8425, y: 0.3557, w: 0.0108, h: 0.1086 },
  { x: 0.9426, y: 0.3824, w: 0.0115, h: 0.0819 },
  { x: 0.9541, y: 0.3661, w: 0.0229, h: 0.0982 },
  { x: 0.9770, y: 0.3824, w: 0.0134, h: 0.0819 },
  { x: 0.9904, y: 0.3780, w: 0.0090, h: 0.0863 },
  { x: 0.0351, y: 0.5253, w: 0.0121, h: 0.0967 },
  { x: 0.0472, y: 0.5327, w: 0.0140, h: 0.0893 },
  { x: 0.0612, y: 0.5074, w: 0.0147, h: 0.1146 },
  { x: 0.0759, y: 0.5372, w: 0.0064, h: 0.0848 },
  { x: 0.0823, y: 0.5074, w: 0.0095, h: 0.1146 },
  { x: 0.0918, y: 0.5074, w: 0.0058, h: 0.1146 },
  { x: 0.1084, y: 0.5074, w: 0.0153, h: 0.1146 },
  { x: 0.1237, y: 0.5179, w: 0.0102, h: 0.1041 },
  { x: 0.1339, y: 0.5164, w: 0.0090, h: 0.1056 },
  { x: 0.1429, y: 0.5253, w: 0.0261, h: 0.0967 },
  { x: 0.1690, y: 0.5074, w: 0.0115, h: 0.1146 },
  { x: 0.1805, y: 0.5074, w: 0.0083, h: 0.1146 },
  { x: 0.1888, y: 0.5074, w: 0.0064, h: 0.1146 },
  { x: 0.2481, y: 0.5313, w: 0.0121, h: 0.0907 },
  { x: 0.2602, y: 0.5074, w: 0.0191, h: 0.1146 },
  { x: 0.2793, y: 0.5104, w: 0.0102, h: 0.1116 },
  { x: 0.2895, y: 0.5208, w: 0.0217, h: 0.1012 },
  { x: 0.3112, y: 0.5387, w: 0.0179, h: 0.0833 },
  { x: 0.3291, y: 0.5253, w: 0.0185, h: 0.0967 },
  { x: 0.3476, y: 0.5074, w: 0.0121, h: 0.1146 },
  { x: 0.3597, y: 0.5074, w: 0.0102, h: 0.1146 },
  { x: 0.3699, y: 0.5387, w: 0.0070, h: 0.0833 },
  { x: 0.3769, y: 0.5074, w: 0.0166, h: 0.1146 },
  { x: 0.4043, y: 0.5253, w: 0.0102, h: 0.0967 },
  { x: 0.4145, y: 0.5402, w: 0.0115, h: 0.0818 },
  { x: 0.4260, y: 0.5074, w: 0.0109, h: 0.1146 },
  { x: 0.4369, y: 0.5089, w: 0.0185, h: 0.1131 },
  { x: 0.4554, y: 0.5074, w: 0.0140, h: 0.1146 },
  { x: 0.4694, y: 0.5342, w: 0.0076, h: 0.0878 },
  { x: 0.5319, y: 0.5372, w: 0.0096, h: 0.0848 },
  { x: 0.5415, y: 0.5372, w: 0.0133, h: 0.0848 },
  { x: 0.5548, y: 0.5193, w: 0.0122, h: 0.1027 },
  { x: 0.5670, y: 0.5342, w: 0.0140, h: 0.0878 },
  { x: 0.5810, y: 0.5074, w: 0.0153, h: 0.1146 },
  { x: 0.6078, y: 0.5342, w: 0.0217, h: 0.0878 },
  { x: 0.6295, y: 0.5179, w: 0.0089, h: 0.1041 },
  { x: 0.6384, y: 0.5179, w: 0.0121, h: 0.1041 },
  { x: 0.6505, y: 0.5074, w: 0.0153, h: 0.1146 },
  { x: 0.6658, y: 0.5074, w: 0.0109, h: 0.1146 },
  { x: 0.7296, y: 0.5372, w: 0.0083, h: 0.0848 },
  { x: 0.7379, y: 0.5327, w: 0.0140, h: 0.0893 },
  { x: 0.7519, y: 0.5089, w: 0.0089, h: 0.1131 },
  { x: 0.7608, y: 0.5089, w: 0.0109, h: 0.1131 },
  { x: 0.7717, y: 0.5193, w: 0.0115, h: 0.1027 },
  { x: 0.7832, y: 0.5238, w: 0.0216, h: 0.0982 },
  { x: 0.8170, y: 0.5149, w: 0.0102, h: 0.1071 },
  { x: 0.8272, y: 0.5119, w: 0.0121, h: 0.1101 },
  { x: 0.8393, y: 0.5119, w: 0.0083, h: 0.1101 },
  { x: 0.8476, y: 0.5357, w: 0.0057, h: 0.0863 },
  { x: 0.9330, y: 0.5104, w: 0.0109, h: 0.1116 },
  { x: 0.9439, y: 0.5104, w: 0.0095, h: 0.1116 },
  { x: 0.9534, y: 0.5268, w: 0.0147, h: 0.0952 },
  { x: 0.9681, y: 0.5074, w: 0.0128, h: 0.1146 },
  { x: 0.9809, y: 0.5208, w: 0.0127, h: 0.1012 },
  { x: 0.9936, y: 0.5327, w: 0.0058, h: 0.0893 },
  { x: 0.0351, y: 0.6622, w: 0.0095, h: 0.1205 },
  { x: 0.0446, y: 0.6905, w: 0.0141, h: 0.0922 },
  { x: 0.0587, y: 0.6711, w: 0.0172, h: 0.1116 },
  { x: 0.0759, y: 0.6622, w: 0.0089, h: 0.1205 },
  { x: 0.0848, y: 0.6622, w: 0.0128, h: 0.1205 },
  { x: 0.1084, y: 0.6801, w: 0.0109, h: 0.1026 },
  { x: 0.1193, y: 0.6622, w: 0.0146, h: 0.1205 },
  { x: 0.1339, y: 0.6771, w: 0.0090, h: 0.1056 },
  { x: 0.1429, y: 0.6801, w: 0.0178, h: 0.1026 },
  { x: 0.1607, y: 0.6622, w: 0.0083, h: 0.1205 },
  { x: 0.1690, y: 0.6622, w: 0.0128, h: 0.1205 },
  { x: 0.1818, y: 0.6726, w: 0.0134, h: 0.1101 },
  { x: 0.2481, y: 0.6622, w: 0.0172, h: 0.1205 },
  { x: 0.2653, y: 0.6622, w: 0.0108, h: 0.1205 },
  { x: 0.2761, y: 0.6622, w: 0.0109, h: 0.1205 },
  { x: 0.2870, y: 0.6711, w: 0.0178, h: 0.1116 },
  { x: 0.3048, y: 0.6622, w: 0.0090, h: 0.1205 },
  { x: 0.3138, y: 0.6696, w: 0.0083, h: 0.1131 },
  { x: 0.3221, y: 0.6801, w: 0.0121, h: 0.1026 },
  { x: 0.3342, y: 0.6815, w: 0.0134, h: 0.1012 },
  { x: 0.3476, y: 0.6637, w: 0.0064, h: 0.1190 },
  { x: 0.3540, y: 0.6637, w: 0.0070, h: 0.1190 },
  { x: 0.3610, y: 0.6637, w: 0.0083, h: 0.1190 },
  { x: 0.3693, y: 0.6622, w: 0.0134, h: 0.1205 },
  { x: 0.3827, y: 0.6622, w: 0.0108, h: 0.1205 },
  { x: 0.4043, y: 0.7009, w: 0.0147, h: 0.0818 },
  { x: 0.4190, y: 0.6979, w: 0.0134, h: 0.0848 },
  { x: 0.4324, y: 0.6637, w: 0.0089, h: 0.1190 },
  { x: 0.4413, y: 0.6637, w: 0.0153, h: 0.1190 },
  { x: 0.4566, y: 0.6801, w: 0.0204, h: 0.1026 },
  { x: 0.5319, y: 0.6622, w: 0.0096, h: 0.1205 },
  { x: 0.5415, y: 0.6979, w: 0.0133, h: 0.0848 },
  { x: 0.5548, y: 0.6741, w: 0.0134, h: 0.1086 },
  { x: 0.5682, y: 0.6771, w: 0.0128, h: 0.1056 },
  { x: 0.5810, y: 0.6622, w: 0.0153, h: 0.1205 },
  { x: 0.6078, y: 0.6801, w: 0.0191, h: 0.1026 },
  { x: 0.6269, y: 0.6830, w: 0.0083, h: 0.0997 },
  { x: 0.6352, y: 0.6622, w: 0.0057, h: 0.1205 },
  { x: 0.6409, y: 0.6845, w: 0.0268, h: 0.0982 },
  { x: 0.6677, y: 0.6726, w: 0.0090, h: 0.1101 },
  { x: 0.7296, y: 0.6949, w: 0.0089, h: 0.0878 },
  { x: 0.7385, y: 0.6622, w: 0.0096, h: 0.1205 },
  { x: 0.7481, y: 0.6622, w: 0.0121, h: 0.1205 },
  { x: 0.7602, y: 0.6801, w: 0.0185, h: 0.1026 },
  { x: 0.7787, y: 0.6801, w: 0.0070, h: 0.1026 },
  { x: 0.7857, y: 0.6622, w: 0.0089, h: 0.1205 },
  { x: 0.7946, y: 0.6622, w: 0.0102, h: 0.1205 },
  { x: 0.8170, y: 0.6726, w: 0.0102, h: 0.1101 },
  { x: 0.8272, y: 0.6741, w: 0.0261, h: 0.1086 },
  { x: 0.9330, y: 0.6622, w: 0.0160, h: 0.1205 },
  { x: 0.9490, y: 0.6786, w: 0.0064, h: 0.1041 },
  { x: 0.9554, y: 0.6994, w: 0.0178, h: 0.0833 },
  { x: 0.9732, y: 0.6637, w: 0.0262, h: 0.1190 },
  { x: 0.0357, y: 0.8304, w: 0.0089, h: 0.1145 },
  { x: 0.0446, y: 0.8304, w: 0.0122, h: 0.1145 },
  { x: 0.0568, y: 0.8363, w: 0.0185, h: 0.1086 },
  { x: 0.0753, y: 0.8304, w: 0.0223, h: 0.1145 },
  { x: 0.1084, y: 0.8378, w: 0.0115, h: 0.1071 },
  { x: 0.1199, y: 0.8423, w: 0.0172, h: 0.1026 },
  { x: 0.1371, y: 0.8423, w: 0.0064, h: 0.1026 },
  { x: 0.1435, y: 0.8304, w: 0.0185, h: 0.1145 },
  { x: 0.1620, y: 0.8304, w: 0.0115, h: 0.1145 },
  { x: 0.1735, y: 0.8304, w: 0.0121, h: 0.1145 },
  { x: 0.1856, y: 0.8304, w: 0.0083, h: 0.1145 },
  { x: 0.2494, y: 0.8304, w: 0.0178, h: 0.1145 },
  { x: 0.2672, y: 0.8304, w: 0.0089, h: 0.1145 },
  { x: 0.2761, y: 0.8304, w: 0.0064, h: 0.1145 },
  { x: 0.2825, y: 0.8571, w: 0.0281, h: 0.0878 },
  { x: 0.3106, y: 0.8348, w: 0.0159, h: 0.1101 },
  { x: 0.3265, y: 0.8304, w: 0.0070, h: 0.1145 },
  { x: 0.3335, y: 0.8304, w: 0.0071, h: 0.1145 },
  { x: 0.3406, y: 0.8438, w: 0.0083, h: 0.1011 },
  { x: 0.3489, y: 0.8571, w: 0.0089, h: 0.0878 },
  { x: 0.3578, y: 0.8571, w: 0.0146, h: 0.0878 },
  { x: 0.3724, y: 0.8304, w: 0.0211, h: 0.1145 },
  { x: 0.4043, y: 0.8586, w: 0.0179, h: 0.0863 },
  { x: 0.4222, y: 0.8601, w: 0.0127, h: 0.0848 },
  { x: 0.4349, y: 0.8318, w: 0.0134, h: 0.1131 },
  { x: 0.4483, y: 0.8318, w: 0.0071, h: 0.1131 },
  { x: 0.4554, y: 0.8304, w: 0.0140, h: 0.1145 },
  { x: 0.4694, y: 0.8304, w: 0.0064, h: 0.1145 },
  { x: 0.5319, y: 0.8304, w: 0.0102, h: 0.1145 },
  { x: 0.5421, y: 0.8304, w: 0.0089, h: 0.1145 },
  { x: 0.5510, y: 0.8601, w: 0.0141, h: 0.0848 },
  { x: 0.5651, y: 0.8601, w: 0.0153, h: 0.0848 },
  { x: 0.5804, y: 0.8304, w: 0.0082, h: 0.1145 },
  { x: 0.5886, y: 0.8304, w: 0.0077, h: 0.1145 },
  { x: 0.6078, y: 0.8571, w: 0.0127, h: 0.0878 },
  { x: 0.6205, y: 0.8304, w: 0.0153, h: 0.1145 },
  { x: 0.6358, y: 0.8631, w: 0.0077, h: 0.0818 },
  { x: 0.6435, y: 0.8393, w: 0.0274, h: 0.1056 },
  { x: 0.6709, y: 0.8304, w: 0.0243, h: 0.1145 },
  { x: 0.6952, y: 0.8378, w: 0.0089, h: 0.1071 },
  { x: 0.8170, y: 0.8304, w: 0.0057, h: 0.1145 },
  { x: 0.8227, y: 0.8304, w: 0.0140, h: 0.1145 },
  { x: 0.8367, y: 0.8304, w: 0.0102, h: 0.1145 },
  { x: 0.8469, y: 0.8616, w: 0.0064, h: 0.0833 },
  { x: 0.9343, y: 0.8304, w: 0.0058, h: 0.1145 },
  { x: 0.9401, y: 0.8304, w: 0.0184, h: 0.1145 },
  { x: 0.9585, y: 0.8601, w: 0.0103, h: 0.0848 },
  { x: 0.9688, y: 0.8318, w: 0.0127, h: 0.1131 },
  { x: 0.9815, y: 0.8601, w: 0.0070, h: 0.0848 },
  { x: 0.9885, y: 0.8304, w: 0.0109, h: 0.1145 }
];

/**
 * How many books the wall can carry: one per painted spine it can mark.
 *
 * This is a ceiling, not a cycle. Past it the OLDEST commission comes off the
 * wall and the newest takes a spine, so the wall never marks one book twice or
 * starts a second, fainter pass over the first.
 */
export const ARCHIVE_MAX = SHELF_BOOKS.length;

/**
 * How far back the wall remembers, for the things that carry a date.
 *
 * Ninety days, because the wall has a spine for every one of several hundred
 * commissions and a shorter memory leaves most of them unused: at fourteen days
 * the wall only filled if that much work concluded inside a fortnight. The
 * count still bounds it, so a busy quarter loses its oldest first.
 */
export const ARCHIVE_WINDOW_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedThing {
  id: string;
  label: string;
  kind: 'commission' | 'assistant';
  /** ms since epoch, or `null` when nothing datable is recorded on it — see
   *  the note above; it is not a bug to fix here. */
  at: number | null;
}

/**
 * The things that get a book, newest last, bounded.
 *
 * Stable for the undated: they keep the order they arrived in, so the wall does
 * not reshuffle itself between polls.
 */
export function shelfBooks(
  things: readonly ArchivedThing[],
  now: number,
  max: number = ARCHIVE_MAX,
  windowDays: number = ARCHIVE_WINDOW_DAYS
): ArchivedThing[] {
  const cutoff = now - windowDays * DAY_MS;
  const inWindow = things.filter((t) => t.at == null || t.at >= cutoff);
  // Oldest falls off first. The undated sort as oldest among themselves but
  // AFTER the dated stale ones have already been filtered out, so a wall of
  // undated assistants is bounded by the count exactly as intended.
  const ordered = inWindow
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.at ?? 0) - (b.t.at ?? 0) || a.i - b.i);
  return ordered.slice(Math.max(0, ordered.length - max)).map((x) => x.t);
}

export interface Box { left: number; top: number; width: number; height: number }

/**
 * One painted volume's rectangle, projected onto the box the room draws into.
 *
 * Total in the index, because the count is data: `ARCHIVE_MAX` bounds the
 * archive to the number of volumes the wall has, but a caller that asks for one
 * past the end should get a book rather than `undefined` geometry that renders
 * as a mark of no size at a coordinate of NaN.
 */
export function bookSlot(index: number, view: { w: number; h: number }): Box {
  const book = SHELF_BOOKS[((index % SHELF_BOOKS.length) + SHELF_BOOKS.length) % SHELF_BOOKS.length];
  return {
    left: book.x * view.w,
    top: book.y * view.h,
    width: book.w * view.w,
    height: book.h * view.h
  };
}
